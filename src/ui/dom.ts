export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

/** Paints the filled portion of a styled range input. */
export function paintRange(input: HTMLInputElement): void {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value);
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;
  input.style.setProperty('--fill', `${percent}%`);
}
