export const SHIFT_EVENT = 'sushi:shift-changed'

export function notifyShiftChanged(): void {
  window.dispatchEvent(new Event(SHIFT_EVENT))
}
