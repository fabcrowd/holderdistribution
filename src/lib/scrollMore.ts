/** True while a scroll box has content below its visible area (1px slack for fractional heights). */
export const hasMoreBelow = (el: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean =>
  el.scrollHeight - el.clientHeight - el.scrollTop > 1;
