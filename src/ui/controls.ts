import type { ExportMode } from '../board/export';
import type { BoardStats } from '../board/board';
import { PALETTE, STROKE } from '../config';
import { luminance } from '../render/color';
import type { GestureMode, Tool } from '../types';
import { el, paintRange } from './dom';
import { loadSettings, saveSettings, type Settings } from './settings';

export interface ControlHandlers {
  onSettingsChange(settings: Settings, key: keyof Settings): void;
  onUndo(): void;
  onRedo(): void;
  onClear(): void;
  onSave(mode: ExportMode): void;
  onStart(): void;
}

export type GateState = 'idle' | 'busy' | 'error' | 'hidden';

export interface GateContent {
  title: string;
  body: string;
  action?: string;
  fine?: string;
}

const GESTURE_NOTES: Record<GestureMode, string> = {
  pinch: 'Touch your thumb to your index fingertip to ink. Separate them to lift the pen.',
  point: 'Extend your index finger and fold the other three to ink.',
  grip: 'Pinch with your ring and little fingers tucked in. Hardest to trigger by accident.',
  any: 'Any of the three gestures inks. Convenient, but easier to start a stroke by mistake.',
};

/** Wires the dock, the settings panel, the gate and the keyboard to one settings object. */
export class Controls {
  readonly settings: Settings;

  private readonly stage = el('stage');
  private readonly toolButtons = [...el('tools').querySelectorAll<HTMLButtonElement>('.tool')];
  private readonly swatchRow = el('swatches');
  private readonly sizeInput = el<HTMLInputElement>('size');
  private readonly sizeValue = el<HTMLOutputElement>('size-value');
  private readonly undoButton = el<HTMLButtonElement>('undo');
  private readonly redoButton = el<HTMLButtonElement>('redo');
  private readonly clearButton = el<HTMLButtonElement>('clear');
  private readonly saveButton = el<HTMLButtonElement>('save');
  private readonly saveMenuToggle = el<HTMLButtonElement>('save-menu-toggle');
  private readonly saveMenu = el('save-menu');

  private readonly settingsToggle = el<HTMLButtonElement>('settings-toggle');
  private readonly settingsPanel = el('settings-panel');
  private readonly gestureSelect = el<HTMLSelectElement>('gesture-mode');
  private readonly gestureNote = el('gesture-note');
  private readonly smoothingInput = el<HTMLInputElement>('smoothing');
  private readonly smoothingValue = el<HTMLOutputElement>('smoothing-value');
  private readonly cameraSelect = el<HTMLSelectElement>('camera-select');
  private readonly mirrorCheck = el<HTMLInputElement>('opt-mirror');
  private readonly skeletonCheck = el<HTMLInputElement>('opt-skeleton');
  private readonly videoCheck = el<HTMLInputElement>('opt-video');

  private readonly gate = el('gate');
  private readonly gateTitle = el('gate-title');
  private readonly gateBody = el('gate-body');
  private readonly gateAction = el<HTMLButtonElement>('gate-action');
  private readonly gateFine = el('gate-fine');

  private readonly toastNode = el('toast');
  private toastTimer = 0;

  private swatchButtons: HTMLButtonElement[] = [];
  private customSwatch!: HTMLLabelElement;
  private customInput!: HTMLInputElement;

  private gateState: GateState = 'idle';

  constructor(private readonly handlers: ControlHandlers) {
    this.settings = loadSettings();
    this.buildSwatches();
    this.bind();
    this.syncAll();
  }

  get activeWidth(): number {
    return this.settings.tool === 'eraser' ? this.settings.eraserWidth : this.settings.penWidth;
  }

  // ---- construction -----------------------------------------------------

  private buildSwatches(): void {
    for (const [index, color] of PALETTE.entries()) {
      const button = document.createElement('button');
      button.className = 'swatch';
      button.type = 'button';
      button.role = 'radio';
      button.style.background = color;
      button.dataset.color = color;
      button.title = `${color} — ${index + 1}`;
      button.setAttribute('aria-label', `Colour ${color}`);
      button.addEventListener('click', () => this.pickColor(color));
      this.swatchRow.append(button);
      this.swatchButtons.push(button);
    }

    const label = document.createElement('label');
    label.className = 'swatch swatch--custom';
    label.title = 'Custom colour';

    const input = document.createElement('input');
    input.type = 'color';
    input.value = this.settings.color;
    input.setAttribute('aria-label', 'Custom colour');
    input.addEventListener('input', () => this.pickColor(input.value));

    label.append(input);
    this.swatchRow.append(label);
    this.customSwatch = label;
    this.customInput = input;
  }

  private bind(): void {
    for (const button of this.toolButtons) {
      button.addEventListener('click', () => this.setTool(button.dataset.tool as Tool));
    }

    this.sizeInput.addEventListener('input', () => {
      this.setWidth(Number(this.sizeInput.value));
    });

    this.undoButton.addEventListener('click', () => this.handlers.onUndo());
    this.redoButton.addEventListener('click', () => this.handlers.onRedo());
    this.clearButton.addEventListener('click', () => this.handlers.onClear());
    this.saveButton.addEventListener('click', () => this.handlers.onSave('ink'));

    this.saveMenuToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleSaveMenu(this.saveMenu.hidden);
    });

    for (const item of this.saveMenu.querySelectorAll<HTMLButtonElement>('[data-export]')) {
      item.addEventListener('click', () => {
        this.toggleSaveMenu(false);
        this.handlers.onSave(item.dataset.export as ExportMode);
      });
    }

    this.settingsToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleSettings(this.settingsPanel.hidden);
    });

    document.addEventListener('click', (event) => {
      const target = event.target as Node;
      if (!this.saveMenu.hidden && !this.saveMenu.contains(target)) this.toggleSaveMenu(false);
      if (!this.settingsPanel.hidden && !this.settingsPanel.contains(target)) {
        this.toggleSettings(false);
      }
    });

    this.gestureSelect.addEventListener('change', () => {
      this.settings.gestureMode = this.gestureSelect.value as GestureMode;
      this.gestureNote.textContent = GESTURE_NOTES[this.settings.gestureMode];
      this.commit('gestureMode');
    });

    this.smoothingInput.addEventListener('input', () => {
      this.settings.smoothing = Number(this.smoothingInput.value) / 100;
      this.syncSmoothing();
      this.commit('smoothing');
    });

    this.cameraSelect.addEventListener('change', () => {
      this.settings.cameraId = this.cameraSelect.value;
      this.commit('cameraId');
    });

    this.mirrorCheck.addEventListener('change', () => {
      this.settings.mirror = this.mirrorCheck.checked;
      this.stage.classList.toggle('stage--mirrored', this.settings.mirror);
      this.commit('mirror');
    });

    this.skeletonCheck.addEventListener('change', () => {
      this.settings.showSkeleton = this.skeletonCheck.checked;
      this.commit('showSkeleton');
    });

    this.videoCheck.addEventListener('change', () => {
      this.settings.showVideo = this.videoCheck.checked;
      this.stage.classList.toggle('stage--novideo', !this.settings.showVideo);
      this.commit('showVideo');
    });

    this.gateAction.addEventListener('click', () => this.handlers.onStart());

    window.addEventListener('keydown', (event) => this.onKeyDown(event));
  }

  // ---- state ------------------------------------------------------------

  private commit(key: keyof Settings): void {
    saveSettings(this.settings);
    this.handlers.onSettingsChange(this.settings, key);
  }

  private setTool(tool: Tool): void {
    if (tool !== 'pen' && tool !== 'eraser') return;
    this.settings.tool = tool;
    this.syncTool();
    this.syncSize();
    this.commit('tool');
  }

  private pickColor(color: string): void {
    this.settings.color = color.toLowerCase();
    // Choosing a colour is also a statement of intent to draw, not erase.
    if (this.settings.tool === 'eraser') {
      this.settings.tool = 'pen';
      this.syncTool();
      this.syncSize();
    }
    this.syncColor();
    this.commit('color');
  }

  private setWidth(width: number): void {
    const clamped = Math.min(Math.max(Math.round(width), STROKE.minWidth), STROKE.maxWidth);
    if (this.settings.tool === 'eraser') this.settings.eraserWidth = clamped;
    else this.settings.penWidth = clamped;
    this.syncSize();
    this.commit(this.settings.tool === 'eraser' ? 'eraserWidth' : 'penWidth');
  }

  private nudgeWidth(delta: number): void {
    this.setWidth(this.activeWidth + delta);
  }

  // ---- syncing ----------------------------------------------------------

  private syncAll(): void {
    this.syncTool();
    this.syncColor();
    this.syncSize();
    this.syncSmoothing();

    this.gestureSelect.value = this.settings.gestureMode;
    this.gestureNote.textContent = GESTURE_NOTES[this.settings.gestureMode];
    this.mirrorCheck.checked = this.settings.mirror;
    this.skeletonCheck.checked = this.settings.showSkeleton;
    this.videoCheck.checked = this.settings.showVideo;
    this.stage.classList.toggle('stage--mirrored', this.settings.mirror);
    this.stage.classList.toggle('stage--novideo', !this.settings.showVideo);
  }

  private syncTool(): void {
    for (const button of this.toolButtons) {
      button.setAttribute('aria-checked', String(button.dataset.tool === this.settings.tool));
    }
  }

  private syncColor(): void {
    document.documentElement.style.setProperty('--ink', this.settings.color);
    this.customInput.value = this.settings.color;

    const current = this.settings.color.toLowerCase();
    let matched = false;
    for (const button of this.swatchButtons) {
      const isActive = button.dataset.color?.toLowerCase() === current;
      button.setAttribute('aria-checked', String(isActive));
      matched ||= isActive;
    }
    this.customSwatch.setAttribute('aria-checked', String(!matched));
    this.customSwatch.classList.toggle('is-active', !matched);
    if (!matched) this.customSwatch.style.background = this.settings.color;
    else this.customSwatch.style.removeProperty('background');

    // Keeps a light custom swatch from vanishing into the panel edge.
    this.customSwatch.style.borderColor =
      !matched && luminance(this.settings.color) > 0.7 ? 'rgb(0 0 0 / 0.35)' : '';
  }

  private syncSize(): void {
    this.sizeInput.value = String(this.activeWidth);
    this.sizeValue.value = String(this.activeWidth);
    paintRange(this.sizeInput);
  }

  private syncSmoothing(): void {
    this.smoothingInput.value = String(Math.round(this.settings.smoothing * 100));
    this.smoothingValue.value = `${Math.round(this.settings.smoothing * 100)}%`;
    paintRange(this.smoothingInput);
  }

  // ---- panels -----------------------------------------------------------

  private toggleSettings(open: boolean): void {
    this.settingsPanel.hidden = !open;
    this.settingsToggle.setAttribute('aria-expanded', String(open));
  }

  private toggleSaveMenu(open: boolean): void {
    this.saveMenu.hidden = !open;
    this.saveMenuToggle.setAttribute('aria-expanded', String(open));
  }

  // ---- public surface ---------------------------------------------------

  setHistory(stats: BoardStats): void {
    this.undoButton.disabled = !stats.canUndo;
    this.redoButton.disabled = !stats.canRedo;
    this.clearButton.disabled = stats.strokes === 0;
    this.saveButton.disabled = stats.strokes === 0;
    this.saveMenuToggle.disabled = stats.strokes === 0;
    if (stats.strokes === 0) this.toggleSaveMenu(false);
  }

  setCameras(devices: MediaDeviceInfo[], activeId: string): void {
    this.cameraSelect.replaceChildren();

    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Default camera';
    this.cameraSelect.append(auto);

    for (const [index, device] of devices.entries()) {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Camera ${index + 1}`;
      this.cameraSelect.append(option);
    }

    const known = devices.some((d) => d.deviceId === activeId);
    this.cameraSelect.value = known ? activeId : '';
    this.settings.cameraId = this.cameraSelect.value;
  }

  setGate(state: GateState, content?: GateContent): void {
    this.gateState = state;
    this.gate.hidden = state === 'hidden';
    this.gate.classList.toggle('gate--error', state === 'error');
    this.stage.classList.toggle('stage--error', state === 'error');

    if (!content) return;
    this.gateTitle.textContent = content.title;
    this.gateBody.textContent = content.body;
    this.gateFine.textContent = content.fine ?? '';
    this.gateFine.hidden = !content.fine;
    this.gateAction.hidden = !content.action;
    this.gateAction.disabled = state === 'busy';
    if (content.action) this.gateAction.textContent = content.action;
  }

  toast(message: string): void {
    this.toastNode.textContent = message;
    this.toastNode.classList.add('toast--on');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastNode.classList.remove('toast--on');
    }, 2200);
  }

  // ---- keyboard ---------------------------------------------------------

  private onKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement;

    if (event.key === 'Escape') {
      this.toggleSaveMenu(false);
      this.toggleSettings(false);
      return;
    }

    const accel = event.metaKey || event.ctrlKey;

    if (accel && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.handlers.onRedo();
      else this.handlers.onUndo();
      return;
    }

    if (accel && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.handlers.onRedo();
      return;
    }

    if (accel || event.altKey || typing) return;

    switch (event.key.toLowerCase()) {
      case 'p':
        this.setTool('pen');
        break;
      case 'e':
        this.setTool('eraser');
        break;
      case '[':
        this.nudgeWidth(-2);
        break;
      case ']':
        this.nudgeWidth(2);
        break;
      case 'c':
        this.handlers.onClear();
        break;
      case 's':
        this.handlers.onSave('ink');
        break;
      case 'h':
        document.body.classList.toggle('ui-hidden');
        break;
      case 'enter':
      case ' ':
        if (this.gateState === 'idle') {
          event.preventDefault();
          this.handlers.onStart();
        }
        return;
      default: {
        const index = Number(event.key) - 1;
        if (Number.isInteger(index) && index >= 0 && index < PALETTE.length) {
          this.pickColor(PALETTE[index]);
        }
        return;
      }
    }
  }
}
