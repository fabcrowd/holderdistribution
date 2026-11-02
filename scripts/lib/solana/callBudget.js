/**
 * Hard cap on RPC calls for one run. The wrapped `call` is only invoked while
 * the budget has room; the counter moves before delegation, so a call that
 * fails still counts against the limit.
 */
export class CallBudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = "CallBudgetError";
  }
}

/**
 * @param {(method: string, params: any[]) => Promise<any>} call
 * @param {number} limit maximum number of calls allowed
 * @returns {{ call: (method: string, params: any[]) => Promise<any>, used: () => number, exhausted: () => boolean }}
 */
export function createCallBudget(call, limit) {
  let allowed = 0;
  return {
    call: async (method, params) => {
      if (allowed + 1 > limit) {
        throw new CallBudgetError(`RPC call budget of ${limit} exhausted; refusing ${method}`);
      }
      allowed += 1;
      return call(method, params);
    },
    used: () => allowed,
    exhausted: () => allowed >= limit,
  };
}
