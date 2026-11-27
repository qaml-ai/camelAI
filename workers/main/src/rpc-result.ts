/** Copy a data-only RPC reply and release its upstream result pipeline. */
export function materializeRpcResult<T>(result: T): T {
  if (
    result === null || typeof result !== 'object' ||
    result instanceof ReadableStream || result instanceof WritableStream ||
    result instanceof Request || result instanceof Response ||
    result instanceof ArrayBuffer || ArrayBuffer.isView(result)
  ) {
    return result;
  }

  const dispose = (result as Partial<Disposable>)[Symbol.dispose];
  if (typeof dispose !== 'function') return result;

  let release = true;
  try {
    return structuredClone(result);
  } catch (error) {
    // RPC can carry live capabilities (like a stream nested in an object)
    // that structuredClone cannot copy. Forward their ownership with the reply.
    if (error instanceof DOMException && error.name === 'DataCloneError') {
      release = false;
      return result;
    }
    throw error;
  } finally {
    if (release) dispose.call(result);
  }
}
