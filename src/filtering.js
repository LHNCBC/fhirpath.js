// Contains the FHIRPath Filtering and Projection functions.  (Section 5.2 of
// the FHIRPath 1.0.0 specification).

const util = require('./utilities');
const {TypeInfo, ResourceNode, FP_Type} = require('./types');
const hashObject = require('./hash-object');
const { deepEqual, maxCollSizeForDeepEqual } = require('./deep-equal');
const equality = require('./equality');

const engine = {};


/**
 * Implements the FHIRPath `where(criteria)` function.
 * Filters the input collection to only those elements that satisfy the given
 * criteria expression.
 * See https://hl7.org/fhirpath/#wherecriteria-expression-collection
 * @param {Array} parentData - the input collection.
 * @param {Function} expr - the criteria expression to evaluate for each element.
 * @returns {Array|Promise<Array>} the filtered collection. Returns a Promise
 *   if any expression evaluation is asynchronous.
 */
engine.whereMacro = function(parentData, expr) {
  if(parentData !== false && ! parentData) { return []; }

  return util.flatten(parentData.map((x, i) => {
    this.$index = i;
    const condition = expr(x);
    if (condition instanceof Promise) {
      return condition.then(c => c[0] ? x : []);
    }
    return condition[0] ? x : [];
  }));
};


/**
 * Implements the FHIR `extension(url)` function.
 * Returns all extensions on each element in the input collection that match
 * the given URL.
 * See https://hl7.org/fhir/fhirpath.html#functions
 * @param {Array} parentData - the input collection.
 * @param {string} url - the extension URL to filter by.
 * @returns {Array} a flat collection of matching Extension ResourceNodes.
 */
engine.extension = function(parentData, url) {
  const ctx = this;
  if(parentData !== false && ! parentData || !url) { return []; }

  return util.flatten(parentData.map((x, i) => {
    this.$index = i;
    const extensions = (x && (x.data && x.data.extension || x._data && x._data.extension));
    if (extensions) {
      return extensions.reduce((list, extension, index) => {
        if(extension.url === url) {
          list.push(ResourceNode.makeResNode(ctx, extension, x, 'Extension', null,
            'Extension', 'extension', index));
        }
        return list;
      }, []);
    }
    return [];
  }));
};


/**
 * Implements the FHIRPath `select(projection)` function.
 * Evaluates the projection expression for each element in the input collection
 * and returns a flattened collection of the results.
 * See https://hl7.org/fhirpath/#selectprojection-expression-collection
 * @param {Array} data - the input collection.
 * @param {Function} expr - the projection expression to evaluate for each
 *   element.
 * @returns {Array} a flattened collection of projected values.
 */
engine.selectMacro = function(data, expr) {
  if(data !== false && ! data) { return []; }
  return util.flatten(data.map((x, i) => {
    this.$index = i;
    return expr(x);
  }));
};

engine.coalesce = function(data, ...exprs) {
  if(data !== false && ! data) { return []; }

  // Evaluate each expression in sequence until we find a non-empty result
  for (let i = 0; i < exprs.length; i++) {
    const expr = exprs[i];
    const result = expr(data);

    // Handle Promise results
    if (result instanceof Promise) {
      return result.then(r => {
        if (util.isSome(r)) {
          return r;
        }
        // Continue with remaining expressions
        const remainingExprs = exprs.slice(i + 1);
        if (remainingExprs.length > 0) {
          return engine.coalesce(data, ...remainingExprs);
        }
        return [];
      });
    }

    // If we found a non-empty result, return it
    if (util.isSome(result)) {
      return result;
    }
  }

  // All expressions returned empty results
  return [];
};

engine.sort = function(data, ...sortArgs) {
  if(data !== false && !data) { return []; }

  const ctx = this;
  // If no sort arguments provided, use natural ordering
  if (sortArgs.length === 0) {
    return data.slice().sort((a, b) => {
      return compareValues(ctx, util.valData(a), util.valData(b));
    });
  }

  // Sort with expressions and directions
  return data.slice().sort((a, b) => {
    for (let i = 0; i < sortArgs.length; i++) {
      const sortArg = sortArgs[i];
      const direction = sortArg.direction || 'asc';

      // Evaluate the sort expression for both items
      const resultA = sortArg.expr([a]);
      const resultB = sortArg.expr([b]);

      // Enforce singleton requirement per specification
      let valA, valB;
      try {
        if (resultA.length > 0) {
          util.assertOnlyOne(resultA, 'Sort expression must return singleton value');
          valA = resultA[0]; // Get the actual value after validation
        } else {
          valA = null;
        }
        if (resultB.length > 0) {
          util.assertOnlyOne(resultB, 'Sort expression must return singleton value');
          valB = resultB[0]; // Get the actual value after validation
        } else {
          valB = null;
        }
      } catch (error) {
        // Re-throw with more context about sort expression requirements
        throw new Error('Sort expression evaluation error: ' + error.message);
      }

      // Extract values for comparison
      valA = valA !== null ? util.valData(valA) : null;
      valB = valB !== null ? util.valData(valB) : null;

      // Compare values using FHIRPath comparison semantics
      let comparison = compareValues(ctx, valA, valB);

      // Apply direction
      if (direction === 'desc') {
        comparison = -comparison;
      }

      // If this sort key produces a difference, return it
      if (comparison !== 0) {
        return comparison;
      }

      // Otherwise, continue to the next sort key
    }

    // All sort keys were equal
    return 0;
  });
};

/**
 * Compare two values using FHIRPath comparison semantics
 * Reuses existing equality.js comparison logic
 */
function compareValues(ctx, a, b) {
  // Handle empty values - per spec: "An empty value is considered lower than all other values"
  if (a == null && b == null) return 0;
  if (a == null) return -1;  // Empty values sort before non-empty values
  if (b == null) return 1;

  // Use existing FHIRPath comparison logic from equality.js
  // Convert to singleton arrays for typecheck
  const [a0, b0] = equality.typecheck(ctx,[a], [b]);

  // Handle FP_Type objects (dates, times, quantities, etc.)
  if (a0 instanceof FP_Type) {
    const compareResult = a0.compare(b0);
    return compareResult === null ? 0 : compareResult;
  }

  // Reject non-primitive types that can't be meaningfully compared
  // Per spec: "Values that would result in comparison errors must be filtered prior to sorting"
  let type = typeof a0;
  if (type === 'object' || type === 'function') {
    throw new Error('Cannot sort by non-primitive type: ' + (a0.constructor?.name || type));
  }
  type = typeof b0;
  if (type === 'object' || type === 'function') {
    throw new Error('Cannot sort by non-primitive type: ' + (b0.constructor?.name || type));
  }

  // Standard JavaScript comparison for basic types
  if (a0 === b0) return 0;
  return a0 < b0 ? -1 : a0 > b0 ? 1 : 0;
}


/**
 * Implements the FHIRPath `repeat(expression)` function.
 * Repeatedly evaluates the given expression on each element, collecting unique
 * results until no new items are produced. Duplicates are excluded using deep
 * equality or hash-based comparison depending on collection size.
 * See https://hl7.org/fhirpath/#repeatexpression-expression-collection
 * @param {Array} parentData - the input collection.
 * @param {Function} expr - the expression to evaluate repeatedly.
 * @param {Object} [state] - internal state for tracking results across
 *   recursive calls.
 * @param {Array} [state.res] - accumulated unique results.
 * @param {Object} [state.unique] - hash map of already-seen items.
 * @param {boolean} [state.hasPrimitive] - whether any primitive values have
 *   been encountered.
 * @returns {Array|Promise<Array>} the collection of all unique results.
 *   Returns a Promise if any expression evaluation is asynchronous.
 */
engine.repeatMacro = function(parentData, expr, state = { res: [], unique: {}, hasPrimitive: false }) {
  const ctx = this;
  if(parentData !== false && ! parentData) { return []; }

  let newItems = [].concat(...parentData.map(i => expr(i)));
  if (newItems.some(i => i instanceof Promise)) {
    return Promise.all(newItems).then(items => {
      items = [].concat(...items);
      if (items.length) {
        return engine.repeatMacro.call(ctx, getNewItems(ctx, items, state), expr, state);
      }
      return state.res;
    });
  } else if (newItems.length) {
    return engine.repeatMacro.call(ctx, getNewItems(ctx, newItems, state), expr, state);
  } else {
    return state.res;
  }
};


/**
 * Returns new items from the input array that are not in the hash of existing
 * unique items and adds them to the result array.
 * @param {Object} ctx - current evaluation context.
 * @param {Array<*>} items - input array.
 * @param {Object} state - current state object.
 * @param {{[key: string]: *}} state.unique - hash of existing unique items.
 * @param {Array<*>} state.res - result array.
 * @param {boolean} state.hasPrimitive - flag indicating if the result array has
 *  primitives.
 * @return {Array<*>}
 */
function getNewItems(ctx, items, state) {
  let newItems;
  state.hasPrimitive = state.hasPrimitive || items.some(i => TypeInfo.isPrimitiveValue(i));
  if (!state.hasPrimitive && items.length + state.res.length > maxCollSizeForDeepEqual) {
    newItems = items.filter(item => {
      const key = hashObject(item);
      const isUnique = !state.unique[key];
      if (isUnique) {
        state.unique[key] = true;
      }
      return isUnique;
    });
    state.res.push.apply(state.res, newItems);
  } else {
    newItems = items.filter(item => {
      const isUnique = !state.res.some(i => deepEqual(ctx, i, item));
      if (isUnique) {
        state.res.push(item);
      }
      return isUnique;
    });
  }
  return newItems;
}


/**
 * Implements the FHIRPath `single()` function.
 * Returns the input collection if it contains exactly one element, an empty
 * collection if it is empty, or throws an error if it contains more than one.
 * See https://hl7.org/fhirpath/#single-collection
 * @param {Array} x - the input collection.
 * @returns {Array} the input collection (0 or 1 element).
 * @throws {Error} if the collection contains more than one element.
 */
engine.singleFn = function(x) {
  if(x.length === 1){
    return x;
  } else if (x.length === 0) {
    return [];
  } else {
    throw new Error("Expected single");
  }
};


/**
 * Implements the FHIRPath `first()` function.
 * Returns the first element of the input collection, or an empty collection
 * if the input is empty.
 * See https://hl7.org/fhirpath/#first-collection
 * @param {Array} x - the input collection.
 * @returns {*} the first element, or undefined if empty.
 */
engine.firstFn = function(x) {
  return x[0];
};


/**
 * Implements the FHIRPath `last()` function.
 * Returns the last element of the input collection, or an empty collection
 * if the input is empty.
 * See https://hl7.org/fhirpath/#last-collection
 * @param {Array} x - the input collection.
 * @returns {*} the last element, or undefined if empty.
 */
engine.lastFn = function(x) {
  return x[x.length - 1];
};


/**
 * Implements the FHIRPath `tail()` function.
 * Returns all elements except the first from the input collection.
 * See https://hl7.org/fhirpath/#tail-collection
 * @param {Array} x - the input collection.
 * @returns {Array} the collection without the first element.
 */
engine.tailFn = function(x) {
  return x.slice(1, x.length);
};


/**
 * Implements the FHIRPath `take(num)` function.
 * Returns the first `n` elements from the input collection.
 * See https://hl7.org/fhirpath/#takenum-integer-collection
 * @param {Array} x - the input collection.
 * @param {number} n - the number of elements to take.
 * @returns {Array} the first `n` elements.
 */
engine.takeFn = function(x, n) {
  return x.slice(0, n);
};


/**
 * Implements the FHIRPath `skip(num)` function.
 * Returns all elements after skipping the first `num` elements.
 * See https://hl7.org/fhirpath/#skipnum-integer-collection
 * @param {Array} x - the input collection.
 * @param {number} num - the number of elements to skip.
 * @returns {Array} the remaining elements after skipping.
 */
engine.skipFn = function(x, num) {
  return x.slice(num, x.length);
};


/**
 * Implements the FHIRPath `ofType(type)` function.
 * Filters the input collection to only those elements that are of the
 * specified type (or convertible to it).
 * See https://hl7.org/fhirpath/#oftypetype-type-specifier-collection
 * @param {Array} coll - the input collection.
 * @param {TypeInfo} typeInfo - the type to filter by.
 * @returns {Array} elements whose type matches or is convertible to the
 *   specified type.
 */
engine.ofTypeFn = function(coll, typeInfo) {
  const ctx = this;
  return coll.filter(value => {
    return TypeInfo.fromValue(value).isConvertibleTo(typeInfo, ctx.model);
  });
};


/**
 * Implements the FHIRPath `distinct()` function.
 * Returns a collection containing only the unique elements from the input.
 * For large collections without primitive values, a hash-based approach is
 * used for efficiency; otherwise, deep equality comparison is used.
 * See https://hl7.org/fhirpath/#distinct-collection
 * @param {Array} x - the input collection.
 * @param {boolean} [hasPrimitive] - optional flag indicating whether the
 *   collection contains primitive values. If not provided, it is determined
 *   automatically.
 * @returns {Array} a collection of distinct elements.
 */
engine.distinctFn = function(x, hasPrimitive = undefined) {
  const ctx = this;
  let unique = [];
  if (x.length > 0) {
    hasPrimitive = hasPrimitive ?? x.some(i => TypeInfo.isPrimitiveValue(i));
    if (!hasPrimitive && x.length > maxCollSizeForDeepEqual) {
      // When we have more than maxCollSizeForDeepEqual items in input collection,
      // we use a hash table (on JSON strings) for efficiency.
      let uniqueHash = {};
      for (let i = 0, len = x.length; i < len; ++i) {
        let xObj = x[i];
        let xStr = hashObject(xObj);
        if (!uniqueHash[xStr]) {
          unique.push(xObj);
          uniqueHash[xStr] = true;
        }
      }
    } else {
      // Otherwise, it is more efficient to perform a deep comparison.
      // Use reverse() + pop() instead of shift() to improve performance and
      // maintain order.
      x = x.concat().reverse();
      do {
        let xObj = x.pop();
        unique.push(xObj);
        x = x.filter(o => !deepEqual(ctx, xObj, o));
      } while (x.length);
    }
  }
  return unique;
};


module.exports = engine;
