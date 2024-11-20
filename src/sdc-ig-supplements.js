// Contains the supplementary FHIRPath functions defined in the Structured Data
// Capture IG, https://hl7.org/fhir/uv/sdc/expressions.html#fhirpath-supplements.

let engine = {};

/**
 * Returns numeric values from the score extension associated with the input
 * collection of Questionnaire items. See the description of the ordinal()
 * function here:
 * https://hl7.org/fhir/uv/sdc/expressions.html#fhirpath-supplements
 * @param {Array} coll - questionnaire items
 * @return {(number|Promise<number>)[]}
 */
engine.weight = function (coll) {
  if(coll !== false && ! coll) { return []; }

  const userScoreExtUrl = this.vars.scoreExt || this.processedVars.scoreExt;
  const checkExtUrl = userScoreExtUrl
    ? (e) => e.url === userScoreExtUrl
    : (e) => this.defaultScoreExts.includes(e.url);
  const res = [];

  const questionnaire = this.vars.questionnaire || this.processedVars.questionnaire?.data;
  let hasPromise = false;

  coll.forEach((elem) => {
    if (elem?.data) {
      const valueCoding = elem.fhirNodeDataType === 'Coding' ? elem.data : elem.data.valueCoding;
      let value = valueCoding;
      if (!value) {
        const prop = Object.keys(elem.data).find(p => p.length > 5 && p.startsWith('value'));
        // if we found a child value[x] property
        value = prop ?
          // we use it to get a score extension
          elem.data[prop]
          // otherwise, if the source item has a simple data type
          : elem._data?.extension ?
            // we get the extension from the adjacent property starting with
            // an underscore
            elem._data
            // otherwise we get the extension from the source item
            // (e.g. 'item' is a Coding)
            : elem.data;
      }
      const score = value?.extension?.find(checkExtUrl)?.valueDecimal;
      if (score !== undefined) {
        // if we have a score extension in the source item, use it.
        res.push(score);
      } else if (valueCoding) {
        const linkIds = getLinkIds(elem.parentResNode);
        if (linkIds.length) {
          if (questionnaire) {
            const qItem = getQItemByLinkIds(questionnaire, linkIds);
            // There are different formats of answer options in the R5/R4/STU3/DSTU2
            // questionnaires.
            const answerOption = qItem?.answerOption?.find(o =>
              // R4 && R5
              o.valueCoding?.code === valueCoding.code
              && o.valueCoding?.system === valueCoding.system
            ) || qItem?.option?.find(o =>
              // STU3
              o.valueCoding?.code === valueCoding.code
              && o.valueCoding?.system === valueCoding.system
              // DSTU2
              || o.code === valueCoding.code
                 && o.system === valueCoding.system
            );
            // There are different formats of URLs for answer value sets in the
            // R5/R4/STU3/DSTU2 questionnaires.
            const itemValueSet = qItem?.answerValueSet || qItem?.options?.reference;
            if (answerOption) {
              const score = answerOption.extension?.find(checkExtUrl)?.valueDecimal;
              if (score !== undefined) {
                // if we have a score extension for the answerOption, use it.
                res.push(score);
              } else if (itemValueSet || valueCoding.system) {
                // Otherwise, check corresponding value set and code system
                hasPromise = addWeightFromCorrespondingResourcesToResult(res, this, questionnaire,
                  itemValueSet, valueCoding.code, valueCoding.system, elem, checkExtUrl) || hasPromise;
              }
            } else if (itemValueSet) {
              // Otherwise, check corresponding value set and code system
              hasPromise = addWeightFromCorrespondingResourcesToResult(res, this, questionnaire,
                itemValueSet, valueCoding.code, valueCoding.system, elem, checkExtUrl) || hasPromise;
            } else {
              throw new Error(
                'Questionnaire answer options (or value set) with this linkId were not found: ' +
                elem.parentResNode.data.linkId + '.');
            }
          } else {
            throw new Error('%questionnaire is needed but not specified.');
          }
        } else if (valueCoding.system) {
          // If there are no questionnaire (no linkId) check corresponding code system
          hasPromise = addWeightFromCorrespondingResourcesToResult(res, this, null,
            null, valueCoding.code, valueCoding.system, elem, checkExtUrl) || hasPromise;
        }
      }
    }
  });

  return hasPromise ? Promise.all(res) : res;
};

// Object for storing received scores
const weightCache = {};
// Object for storing fetch promises.
const requestCache = {};
// Duration of data storage in cache.
const cacheStorageTime = 3600000; // 1 hour = 60 * 60 * 1000

/**
 * Caches score.
 * @param {string} key - key to store score in cache.
 * @param {number|Promise} value - value of score or promise of value.
 */
function putScoreToCache(key, value) {
  weightCache[key] = {
    timestamp: Date.now(),
    value
  };
}

/**
 * Checks if there is an unexpired score in the cache.
 * @param {string} key - key to store score in cache.
 * @return {boolean|undefined}
 */
function hasScoreInCache(key) {
  return weightCache[key] && Date.now() - weightCache[key].timestamp < cacheStorageTime;
}

/**
 * Returns a score or promise of score from the cache. Does not check the
 * expiration time. {@link hasScoreInCache} should be called before this
 * function.
 * @param {string} key - key to store score in cache.
 * @return {number | Promise}
 */
function getScoreFromCache(key) {
  return weightCache[key].value;
}

/**
 * fetch() wrapper for caching server responses.
 * @param {string} url - a URL of the resource you want to fetch.
 * @param {object} [options] - optional object containing any custom settings
 *  that you want to apply to the request.
 * @return {Promise}
 */
function fetchWithCache(url, options) {
  const requestKey = [
    url, options ? JSON.stringify(options) : ''
  ].join('|');

  const timestamp = Date.now();
  for (const key in requestCache) {
    if (timestamp - requestCache[key].timestamp > cacheStorageTime) {
      // Remove responses older than an hour
      delete requestCache[key];
    }
  }

  if (!requestCache[requestKey]) {
    requestCache[requestKey] = {
      timestamp,
      promise: options ? fetch(url, options) : fetch(url)
    };
  }

  return requestCache[requestKey].promise;
}

/**
 * Adds the value of score or its promise received from a corresponding value
 * set or code system to the result array.
 * @param {Array} res - result array.
 * @param {Object} ctx - object describing the context of expression
 *  evaluation (see the "applyParsedPath" function).
 * @param {Object} questionnaire - object containing questionnaire resource data
 * @param {string} vsURL - value set URL specified in the Questionnaire item.
 * @param {string} code - symbol in syntax defined by the system.
 * @param {string} system - code system.
 * @param {ResourceNode|any} elem - source collection item for which we obtain
 *  the score value.
 * @param {Function} checkExtUrl - function to check if the extension passed as
 *  a parameter has a score URL.
 * @return {boolean} a flag indicating that a promise has been added to the
 *  resulting array.
 */
function addWeightFromCorrespondingResourcesToResult(res, ctx, questionnaire,
  vsURL, code, system, elem, checkExtUrl) {
  let score;
  const cacheKey = [
    ctx.model?.version,
    questionnaire?.url || questionnaire?.id,
    vsURL, code, system
  ].join('|');

  if (hasScoreInCache(cacheKey)) {
    score =  getScoreFromCache(cacheKey);
  } else {
    if (code) {
      if (vsURL) {
        const vsId = /^#(.*)/.test(vsURL) ? RegExp.$1 : null;
        const isAnswerValueSet = vsId
          ? (r) => r.id === vsId && r.resourceType === 'ValueSet'
          : (r) => r.url === vsURL && r.resourceType === 'ValueSet';

        const containedVS = questionnaire?.contained?.find(isAnswerValueSet);

        if (containedVS) {
          if (!containedVS.expansion) {
            const parameters = [{
              "name": "valueSet",
              "resource": containedVS
            }];
            if (ctx.model?.version === 'r5') {
              parameters.push({
                "name": "property",
                "valueString": "itemWeight"
              });
            }
            score = fetchWithCache(`${getTerminologyUrl(ctx)}/ValueSet/$expand`, {
              method: 'POST',
              headers: {
                'Accept': 'application/fhir+json',
                'Content-Type': 'application/fhir+json'
              },
              body: JSON.stringify({
                "resourceType": "Parameters",
                "parameter": parameters
              })
            })
              .then(r => r.ok ? r.json() : Promise.reject(r.json()))
              .then((terminologyVS) => {
                return getScoreFromVS(ctx.model?.version, terminologyVS,
                  checkExtUrl, code, system);
              });
          } else {
            score = getScoreFromVS(ctx.model?.version, containedVS, checkExtUrl,
              code, system);
          }
        } else {
          const parameters = ctx.model?.version === 'dstu2' ?
            {identifier: vsURL} : { url: vsURL };
          if (ctx.model?.version === 'r5') {
            parameters.property = 'itemWeight';
          }
          score = fetchWithCache(`${getTerminologyUrl(ctx)}/ValueSet/$expand?` +
            new URLSearchParams(parameters).toString(), {
            headers: {
              'Accept': 'application/fhir+json'
            }
          })
            .then(r => r.ok ? r.json() : Promise.reject(r.json()))
            .then((terminologyVS) => {
              return getScoreFromVS(ctx.model?.version, terminologyVS,
                checkExtUrl, code, system);
            });
        }
      } // end if (vsURL)

      if (system && ctx.model?.version !== 'dstu2') {
        if (score === undefined) {
          const isCodeSystem = (r) => r.url === system && r.resourceType === 'CodeSystem';
          const containedCS = getContainedResources(elem)?.find(isCodeSystem)
            || questionnaire?.contained?.find(isCodeSystem);

          if (containedCS) {
            if (checkIfItemWeightExists(containedCS?.property)) {
              score = getItemWeightFromProperty(
                getCodeSystemItem(containedCS?.concept, code)
              );
            }
          } else {
            score = getWeightFromTerminologyCodeSet(ctx, code, system);
          }
        } else if (score instanceof Promise) {
          score = score.then(weightFromVS => {
            if (weightFromVS !== undefined) {
              return weightFromVS;
            }
            return getWeightFromTerminologyCodeSet(ctx, code, system);
          });
        }
      }
    }

    putScoreToCache(cacheKey, score);
  }

  if (score !== undefined) {
    res.push(score);
  }

  return score instanceof Promise;
}


/**
 * Returns the promised score value from the code system obtained from the
 * terminology server.
 * @param {Object} ctx - object describing the context of expression
 *  evaluation (see the "applyParsedPath" function).
 * @param {string} code - symbol in syntax defined by the system.
 * @param {string} system - code system.
 * @return {Promise<number|undefined>}
 */
function getWeightFromTerminologyCodeSet(ctx, code, system) {
  const terminologyUrl = getTerminologyUrl(ctx);
  return fetchWithCache(`${terminologyUrl}/CodeSystem?` + new URLSearchParams({
    url: system,
    _elements: 'property'
  }).toString(), {
    headers: {
      'Accept': 'application/fhir+json'
    }
  })
    .then(r => r.ok ? r.json() : Promise.reject(r.json()))
    .then(bundle => {
      if (checkIfItemWeightExists(bundle?.entry?.[0]?.resource?.property)) {
        return fetchWithCache(`${terminologyUrl}/CodeSystem/$lookup?` + new URLSearchParams({
          code, system, property: 'itemWeight'
        }).toString(), {
          headers: {
            'Accept': 'application/fhir+json'
          }
        })
          .then(r => r.ok ? r.json() : Promise.reject(r.json()))
          .then((parameters) => {
            return parameters.parameter
              .find(p => p.name === 'property'&& p.part
                .find(part => part.name === 'code' && part.valueCode === 'itemWeight'))
              ?.part?.find(p => p.name === 'value')?.valueDecimal;
          });
      }
    });
}


/**
 * Returns the URL of the terminology server.
 * @param {Object} ctx - object describing the context of expression
 *  evaluation (see the "applyParsedPath" function).
 * @return {string}
 */
function getTerminologyUrl(ctx) {
  if (!ctx.async) {
    throw new Error('The asynchronous function "weight"/"ordinal" is not allowed. ' +
      'To enable asynchronous functions, use the async=true or async="always"' +
      ' option.');
  }

  const terminologyUrl = ctx.processedVars.terminologies?.terminologyUrl;
  if (!terminologyUrl) {
    throw new Error('Option "terminologyUrl" is not specified.');
  }

  return terminologyUrl;
}

/**
 * Returns an item from "ValueSet.expansion.contains" that has the specified
 * code and system.
 * @param {Array<Object>} contains - value of "ValueSet.expansion.contains".
 * @param {string} code - symbol in syntax defined by the system.
 * @param {string} system - code system.
 * @return {Object| undefined}
 */
function getValueSetItem(contains, code, system) {
  let result;
  if (contains) {
    for(let i = 0; i < contains.length && !result; i++) {
      const item = contains[i];
      if (item.code === code && item.system === system) {
        result = item;
      } else {
        result = getValueSetItem(item.contains, code, system);
      }
    }
  }
  return result;
}


/**
 * Returns an item from "CodeSystem.concept" that has the specified code.
 * @param {Array<Object>} concept - value of "CodeSystem.concept".
 * @param {string} code - symbol in syntax defined by the system.
 * @return {Object| undefined}
 */
function getCodeSystemItem(concept, code) {
  let result;
  if (concept) {
    for(let i = 0; i < concept.length && !result; i++) {
      const item = concept[i];
      if (item.code === code) {
        result = item;
      } else if (item.concept) {
        result = getCodeSystemItem(item.concept, code);
      }
    }
  }
  return result;
}

/**
 * Checks if the itemWeight property from the set of common concept properties
 * (http://hl7.org/fhir/concept-properties) exists in the additional information
 * supplied about each concept.
 * @param {Object} properties - ValueSet.expansion.property or
 *  CodeSystem.property.
 * @return {boolean}
 */
function checkIfItemWeightExists(properties) {
  return properties?.find(p => p.code === 'itemWeight')?.uri ===
    'http://hl7.org/fhir/concept-properties';
}

/**
 * Returns the value of the itemWeight property from a value set item.
 * @param {Object} item - an item from a ValueSet.expansion.contains or
 *  CodeSystem.concept.
 * @return {number | undefined}
 */
function getItemWeightFromProperty(item) {
  return item?.property?.find(p => p.code === 'itemWeight')?.valueDecimal;
}

/**
 * Returns the value of the itemWeight property or score extension for the
 * specified system and code from a value set.
 * @param {string} modelVersion - model version, e.g. 'r5', 'r4', 'stu3', or 'dstu2'.
 * @param {Object} vs - ValueSet.
 * @param {Function} checkExtUrl - function to check if the extension passed as
 *  a parameter has a score URL.
 * @param {string} code - symbol in syntax defined by the system.
 * @param {string} system - code system.
 * @return {number|undefined}
 */
function getScoreFromVS(modelVersion, vs, checkExtUrl, code, system) {
  const item = getValueSetItem(vs.expansion?.contains, code, system);

  return item && (
    modelVersion === 'r5' && checkIfItemWeightExists(vs.expansion?.property) &&
    getItemWeightFromProperty(item) ||
    item?.extension?.find(checkExtUrl)?.valueDecimal
  );
}


/**
 * Returns array of linkIds of ancestor ResourceNodes and source ResourceNode
 * starting with the linkId of the given node and ending with the topmost item's
 * linkId.
 * @param {ResourceNode} node - source ResourceNode.
 * @return {String[]}
 */
function getLinkIds(node) {
  const res = [];

  while (node.data?.linkId) {
    res.push(node.data.linkId);
    node = node.parentResNode;
  }

  return res;
}


/**
 * Returns the "contained" property of the resource to which the ResourceNode
 * belongs, or an undefined value if not a ResourceNode was passed or if there
 * is no contained property.
 * @param {ResourceNode|any} node - source ResourceNode or something else.
 * @return {Object[]|undefined}
 */
function getContainedResources(node) {
  while (node) {
    if (node.data?.resourceType && node.data?.contained) {
      return node.data?.contained;
    }
    node = node.parentResNode;
  }
}


/**
 * Returns a questionnaire item based on the linkIds array of the ancestor
 * ResourceNodes and the target ResourceNode. If the questionnaire item is not
 * found, it returns null.
 * @param {Object} questionnaire - object with a Questionnaire resource.
 * @param {string[]} linkIds - array of linkIds starting with the linkId of the
 * target node and ending with the topmost known item's linkId.
 * @return {Object | null}
 */
function getQItemByLinkIds(questionnaire, linkIds) {
  let currentNode;
  const topLinkId = linkIds[linkIds.length-1];

  if (questionnaire.group) {
    // Search for an item in a questionnaire specified in DSTU2 format
    let collection = questionnaire.group;

    // Find the questionnaire item that matches the linkId of the topmost known
    // item.
    while (collection?.length > 0) {
      currentNode = collection.find(o => o.linkId === topLinkId);
      if (currentNode) {
        break;
      } else {
        collection = [].concat(...collection.map(i => [].concat(i.item || [], i.group || [])));
      }
    }

    // Getting a questionnaire item relative to the topmost known item using
    // subsequent linkIds.
    for(let i = linkIds.length-2; i >= 0 && currentNode; --i) {
      currentNode = currentNode.question?.find(o => o.linkId === linkIds[i]) ||
        currentNode.group?.find(o => o.linkId === linkIds[i]);
    }

  } else {
    // Search for an item in a questionnaire specified in STU3, R4 or R5 format
    let collection = questionnaire.item;

    // Find the questionnaire item that matches the linkId of the topmost known
    // item.
    while (collection?.length > 0) {
      currentNode = collection.find(o => o.linkId === topLinkId);
      if (currentNode) {
        break;
      } else {
        collection = [].concat(...collection.map(i => i.item || []));
      }
    }

    // Getting a questionnaire item relative to the topmost known item using
    // subsequent linkIds.
    for(let i = linkIds.length-2; i >= 0 && currentNode; --i) {
      currentNode = currentNode.item?.find(o => o.linkId === linkIds[i]);
    }
  }
  return currentNode;
}

module.exports = engine;
