// v2 removes the obsolete weapon-swap action: this ruleset has one weapon set.
export const KEYBINDING_SCHEMA_VERSION = 2;
export const KEYBINDING_STORAGE_KEY = "rotw.keybindings";

export const KeybindingAction = Object.freeze({
  INVENTORY: "inventory",
  HIRELING: "hireling",
  CHARACTER: "character",
  SKILLS: "skills",
  QUESTS: "quests",
  MAP: "map",
  BELT_SLOT_1: "beltSlot1",
  BELT_SLOT_2: "beltSlot2",
  BELT_SLOT_3: "beltSlot3",
  BELT_SLOT_4: "beltSlot4",
  TOWN_PORTAL: "townPortal",
  ESCAPE: "escape",
});

function freezeBindings(bindings) {
  return Object.freeze(Object.fromEntries(
    Object.entries(bindings).map(([actionId, values]) => [actionId, Object.freeze([...values])]),
  ));
}

// P is intentionally reserved for the independently remappable town portal.
// Inventory and character keep both of their requested aliases as one action.
export const DEFAULT_KEYBINDINGS = freezeBindings({
  [KeybindingAction.INVENTORY]: ["KeyI", "KeyB"],
  [KeybindingAction.HIRELING]: ["KeyO"],
  [KeybindingAction.CHARACTER]: ["KeyC", "KeyA"],
  [KeybindingAction.SKILLS]: ["KeyT"],
  [KeybindingAction.QUESTS]: ["KeyQ"],
  [KeybindingAction.MAP]: ["Tab"],
  [KeybindingAction.BELT_SLOT_1]: ["Digit1"],
  [KeybindingAction.BELT_SLOT_2]: ["Digit2"],
  [KeybindingAction.BELT_SLOT_3]: ["Digit3"],
  [KeybindingAction.BELT_SLOT_4]: ["Digit4"],
  [KeybindingAction.TOWN_PORTAL]: ["KeyP"],
  [KeybindingAction.ESCAPE]: ["Escape"],
});

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"];
const MODIFIER_ALIASES = new Map([
  ["ctrl", "Ctrl"], ["control", "Ctrl"],
  ["alt", "Alt"], ["option", "Alt"],
  ["shift", "Shift"],
  ["meta", "Meta"], ["cmd", "Meta"], ["command", "Meta"], ["win", "Meta"], ["windows", "Meta"],
]);
const CODE_ALIASES = new Map([
  ["esc", "Escape"], ["escape", "Escape"],
  ["tab", "Tab"], ["space", "Space"], ["spacebar", "Space"], [" ", "Space"],
  ["enter", "Enter"], ["return", "Enter"],
  ["backspace", "Backspace"], ["delete", "Delete"], ["del", "Delete"], ["insert", "Insert"],
  ["home", "Home"], ["end", "End"], ["pageup", "PageUp"], ["pagedown", "PageDown"],
  ["arrowup", "ArrowUp"], ["up", "ArrowUp"], ["arrowdown", "ArrowDown"], ["down", "ArrowDown"],
  ["arrowleft", "ArrowLeft"], ["left", "ArrowLeft"], ["arrowright", "ArrowRight"], ["right", "ArrowRight"],
  ["backquote", "Backquote"], ["`", "Backquote"], ["minus", "Minus"], ["-", "Minus"],
  ["equal", "Equal"], ["=", "Equal"], ["bracketleft", "BracketLeft"], ["[", "BracketLeft"],
  ["bracketright", "BracketRight"], ["]", "BracketRight"], ["backslash", "Backslash"], ["\\", "Backslash"],
  ["semicolon", "Semicolon"], [";", "Semicolon"], ["quote", "Quote"], ["'", "Quote"],
  ["comma", "Comma"], [",", "Comma"], ["period", "Period"], [".", "Period"],
  ["slash", "Slash"], ["/", "Slash"],
]);
const MODIFIER_CODES = new Set(["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"]);

function normaliseCode(value) {
  const token = String(value ?? "").trim();
  if (!token) throw new TypeError("A keybinding needs a key");
  const lower = token.toLowerCase();
  if (CODE_ALIASES.has(lower)) return CODE_ALIASES.get(lower);
  if (/^[a-z]$/i.test(token)) return `Key${token.toUpperCase()}`;
  if (/^key[a-z]$/i.test(token)) return `Key${token.at(-1).toUpperCase()}`;
  if (/^[0-9]$/.test(token)) return `Digit${token}`;
  if (/^digit[0-9]$/i.test(token)) return `Digit${token.at(-1)}`;
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(token);
  if (functionKey) return `F${functionKey[1]}`;
  const numpad = /^numpad([0-9]|add|subtract|multiply|divide|decimal|enter)$/i.exec(token);
  if (numpad) return `Numpad${numpad[1][0].toUpperCase()}${numpad[1].slice(1).toLowerCase()}`;
  if (/^(?:Escape|Tab|Space|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/.test(token)) return token;
  if (/^[A-Z][A-Za-z0-9]*$/.test(token)) return token;
  throw new TypeError(`Unsupported key code: ${token}`);
}

/** Convert `i`, `Ctrl+I`, or a KeyboardEvent-like object to a stable, code-based chord. */
export function normalizeBinding(binding) {
  if (binding && typeof binding === "object") return bindingFromEvent(binding);
  if (typeof binding !== "string") throw new TypeError("A keybinding must be a string or KeyboardEvent-like object");
  const parts = binding.split("+").map((part) => part.trim()).filter(Boolean);
  const modifiers = new Set();
  let code = null;
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES.get(part.toLowerCase());
    if (modifier) {
      modifiers.add(modifier);
    } else if (code === null) {
      code = normaliseCode(part);
    } else {
      throw new TypeError(`A keybinding may contain only one non-modifier key: ${binding}`);
    }
  }
  if (code === null || MODIFIER_CODES.has(code)) throw new TypeError("Modifier-only shortcuts are not supported");
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), code].join("+");
}

/** Prefer KeyboardEvent.code so remapped controls stay physical-layout independent. */
export function bindingFromEvent(event) {
  if (!event || typeof event !== "object") throw new TypeError("Expected a KeyboardEvent-like object");
  const rawCode = event.code || event.key;
  if (!rawCode || rawCode === "Unidentified" || rawCode === "Dead" || MODIFIER_CODES.has(rawCode)) return null;
  const code = normaliseCode(rawCode);
  const modifiers = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push("Meta");
  return [...modifiers, code].join("+");
}

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function hasAttribute(node, name) {
  return typeof node?.hasAttribute === "function" && node.hasAttribute(name);
}

function getAttribute(node, name) {
  return typeof node?.getAttribute === "function" ? node.getAttribute(name) : null;
}

function nodeCapturesKeyboard(node) {
  if (!node || typeof node !== "object") return false;
  const tagName = lower(node.tagName || node.nodeName);
  if (["input", "textarea", "select"].includes(tagName)) return true;
  if (node.isContentEditable === true) return true;
  const contentEditable = lower(getAttribute(node, "contenteditable") ?? node.contentEditable);
  // HTMLElement.contentEditable defaults to "inherit" even on ordinary BODY/DIV
  // nodes. Only an explicit editable attribute should suppress game shortcuts.
  if (hasAttribute(node, "contenteditable") && contentEditable !== "false") return true;
  if (lower(getAttribute(node, "role")) === "textbox") return true;

  const id = lower(node.id);
  const className = lower(typeof node.className === "string" ? node.className : node.className?.baseVal);
  const classes = className.split(/\s+/).filter(Boolean);
  const dataset = node.dataset ?? {};
  return id === "console"
    || id === "game-console"
    || classes.some((name) => ["console", "game-console", "command-console"].includes(name))
    || hasAttribute(node, "data-console")
    || hasAttribute(node, "data-game-console")
    || lower(dataset.keyboardScope) === "console"
    || lower(dataset.keybindings) === "off"
    || lower(dataset.hotkeys) === "off";
}

/** True for typing controls, contenteditable regions, and game-console descendants. */
export function isKeyboardCaptureTarget(target) {
  const visited = new Set();
  let node = target?.nodeType === 3 ? target.parentElement || target.parentNode : target;
  while (node && typeof node === "object" && !visited.has(node)) {
    if (nodeCapturesKeyboard(node)) return true;
    visited.add(node);
    node = node.parentElement || node.parentNode || node.host || null;
  }
  return false;
}

export function shouldIgnoreKeyboardEvent(event) {
  if (!event || event.defaultPrevented || event.isComposing || event.keyCode === 229) return true;
  const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
  return path.some(isKeyboardCaptureTarget);
}

function cloneBindings(bindings) {
  return Object.fromEntries(Object.entries(bindings).map(([actionId, values]) => [actionId, [...values]]));
}

function normaliseBindingList(value, actionId) {
  const list = value == null ? [] : Array.isArray(value) ? value : [value];
  const normalized = list.map((binding) => {
    const result = normalizeBinding(binding);
    if (!result) throw new TypeError(`Action ${actionId} has an unusable keybinding`);
    return result;
  });
  return [...new Set(normalized)];
}

function normaliseBindingsMap(bindings, { includeDefaults = false } = {}) {
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) throw new TypeError("Keybindings must be an action-to-bindings object");
  const source = includeDefaults ? { ...DEFAULT_KEYBINDINGS, ...bindings } : bindings;
  return Object.fromEntries(Object.entries(source).map(([actionId, values]) => {
    if (!actionId) throw new TypeError("A keybinding action needs an id");
    return [actionId, normaliseBindingList(values, actionId)];
  }));
}

export function findBindingConflicts(bindings) {
  const normalized = normaliseBindingsMap(bindings);
  const owners = new Map();
  for (const [actionId, values] of Object.entries(normalized)) {
    for (const binding of values) {
      if (!owners.has(binding)) owners.set(binding, []);
      owners.get(binding).push(actionId);
    }
  }
  return [...owners.entries()]
    .filter(([, actionIds]) => new Set(actionIds).size > 1)
    .map(([binding, actionIds]) => ({ binding, actionIds: [...new Set(actionIds)] }));
}

// Concise alias for settings screens that ask "find conflicts" before applying.
export const findConflicts = findBindingConflicts;

export class KeybindingConflictError extends Error {
  constructor(conflicts) {
    const detail = conflicts.map(({ binding, actionIds }) => `${binding}: ${actionIds.join(", ")}`).join("; ");
    super(`Keybinding conflict${conflicts.length === 1 ? "" : "s"}: ${detail}`);
    this.name = "KeybindingConflictError";
    this.code = "KEYBINDING_CONFLICT";
    this.conflicts = conflicts.map(({ binding, actionIds }) => ({ binding, actionIds: [...actionIds] }));
  }
}

export function assertNoBindingConflicts(bindings) {
  const conflicts = findBindingConflicts(bindings);
  if (conflicts.length) throw new KeybindingConflictError(conflicts);
  return true;
}

export function serializeKeybindings(bindings) {
  const normalized = normaliseBindingsMap(bindings);
  // Deliberately validate before constructing data that can be persisted.
  assertNoBindingConflicts(normalized);
  return { schemaVersion: KEYBINDING_SCHEMA_VERSION, bindings: cloneBindings(normalized) };
}

export function deserializeKeybindings(value) {
  const data = typeof value === "string" ? JSON.parse(value) : value;
  if (!data || data.schemaVersion !== KEYBINDING_SCHEMA_VERSION) {
    throw new Error(`Unsupported keybinding schema: ${data?.schemaVersion}`);
  }
  const normalized = normaliseBindingsMap(data.bindings, { includeDefaults: true });
  assertNoBindingConflicts(normalized);
  return normalized;
}

function wasHandled(result, defaultValue = false) {
  if (result && typeof result === "object" && "handled" in result) return result.handled === true;
  return defaultValue ? result !== false : result === true;
}

/**
 * Browser-neutral shortcut registry. `actions` contains ordinary callbacks;
 * Escape callbacks return true only when their tier had something to handle.
 */
export class KeybindingManager {
  constructor({ bindings = DEFAULT_KEYBINDINGS, actions = {}, handlers, onAction = null, escape = {}, ignoreRepeat = true } = {}) {
    const normalized = normaliseBindingsMap(bindings, { includeDefaults: true });
    assertNoBindingConflicts(normalized);
    this._bindings = normalized;
    this._actions = { ...actions, ...(handlers ?? {}) };
    this._onAction = onAction;
    this._escape = { ...escape };
    this.ignoreRepeat = ignoreRepeat;
    this._attachments = new Set();
    this._rebuildLookup();
  }

  get bindings() {
    return this.getAllBindings();
  }

  getAllBindings() {
    return cloneBindings(this._bindings);
  }

  getBindings(actionId) {
    this._assertAction(actionId);
    return [...this._bindings[actionId]];
  }

  getActionForBinding(binding) {
    const normalized = normalizeBinding(binding);
    return normalized ? this._lookup.get(normalized) ?? null : null;
  }

  getActionForEvent(event) {
    const binding = bindingFromEvent(event);
    return binding ? this._lookup.get(binding) ?? null : null;
  }

  findConflicts(candidate = this._bindings) {
    return findBindingConflicts(candidate);
  }

  canRemap(actionId, binding, options = {}) {
    const candidate = this._candidateForRemap(actionId, binding, options);
    const conflicts = findBindingConflicts(candidate);
    return { ok: conflicts.length === 0, conflicts, bindings: cloneBindings(candidate) };
  }

  /** Replace one alias (the primary alias by default) only after conflict validation. */
  remap(actionId, binding, options = {}) {
    const candidate = this._candidateForRemap(actionId, binding, options);
    this._commit(candidate);
    return this.getBindings(actionId);
  }

  setBindings(actionId, bindings) {
    this._assertAction(actionId);
    const candidate = cloneBindings(this._bindings);
    candidate[actionId] = normaliseBindingList(bindings, actionId);
    this._commit(candidate);
    return this.getBindings(actionId);
  }

  addBinding(actionId, binding) {
    return this.setBindings(actionId, [...this.getBindings(actionId), binding]);
  }

  removeBinding(actionId, binding) {
    const normalized = normalizeBinding(binding);
    return this.setBindings(actionId, this.getBindings(actionId).filter((value) => value !== normalized));
  }

  reset(actionId) {
    if (actionId === undefined) {
      this._commit(cloneBindings(DEFAULT_KEYBINDINGS));
      return this.getAllBindings();
    }
    this._assertAction(actionId);
    return this.setBindings(actionId, DEFAULT_KEYBINDINGS[actionId] ?? []);
  }

  setActionHandler(actionId, handler) {
    this._assertAction(actionId);
    if (handler == null) delete this._actions[actionId];
    else if (typeof handler === "function") this._actions[actionId] = handler;
    else throw new TypeError("An action handler must be a function");
    return this;
  }

  setEscapeHandlers(handlers = {}) {
    this._escape = { ...handlers };
    return this;
  }

  handleKeydown(event, context = {}) {
    if (shouldIgnoreKeyboardEvent(event)) return { handled: false, reason: "ignored-target" };
    if (this.ignoreRepeat && event.repeat) return { handled: false, reason: "repeat" };
    const binding = bindingFromEvent(event);
    if (!binding) return { handled: false, reason: "unidentified-key" };
    const actionId = this._lookup.get(binding);
    if (!actionId) return { handled: false, reason: "unbound", binding };

    const payload = { actionId, binding, event, manager: this };
    let result;
    if (actionId === KeybindingAction.ESCAPE) result = this._dispatchEscape(payload, context);
    else result = this._dispatchAction(payload, context);
    if (!result.handled) return { ...result, actionId, binding };

    if (context.preventDefault !== false && typeof event.preventDefault === "function") event.preventDefault();
    if (context.stopImmediatePropagation === true && typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
    else if (context.stopPropagation !== false && typeof event.stopPropagation === "function") event.stopPropagation();
    return { ...result, handled: true, actionId, binding };
  }

  /** Attach one listener; returned cleanup only detaches this attachment. */
  attach(target, getContext = () => ({}), listenerOptions = false) {
    if (!target || typeof target.addEventListener !== "function") throw new TypeError("attach() needs an EventTarget");
    if (typeof getContext !== "function") throw new TypeError("getContext must be a function");
    const listener = (event) => this.handleKeydown(event, getContext(event) ?? {});
    target.addEventListener("keydown", listener, listenerOptions);
    const attachment = { target, listener, listenerOptions };
    this._attachments.add(attachment);
    return () => {
      if (!this._attachments.delete(attachment)) return false;
      target.removeEventListener("keydown", listener, listenerOptions);
      return true;
    };
  }

  detach() {
    for (const { target, listener, listenerOptions } of this._attachments) {
      target.removeEventListener("keydown", listener, listenerOptions);
    }
    this._attachments.clear();
  }

  serialize() {
    return serializeKeybindings(this._bindings);
  }

  toJSON() {
    return this.serialize();
  }

  save(storage, key = KEYBINDING_STORAGE_KEY) {
    if (!storage || typeof storage.setItem !== "function") throw new TypeError("save() needs a Storage-like object");
    const serialized = JSON.stringify(this.serialize()); // validation happens before setItem
    storage.setItem(key, serialized);
    return serialized;
  }

  static deserialize(value, options = {}) {
    return new KeybindingManager({ ...options, bindings: deserializeKeybindings(value) });
  }

  static fromJSON(value, options = {}) {
    return KeybindingManager.deserialize(value, options);
  }

  static load(storage, key = KEYBINDING_STORAGE_KEY, options = {}) {
    if (!storage || typeof storage.getItem !== "function") throw new TypeError("load() needs a Storage-like object");
    const value = storage.getItem(key);
    return value == null ? new KeybindingManager(options) : KeybindingManager.deserialize(value, options);
  }

  _candidateForRemap(actionId, binding, options = {}) {
    this._assertAction(actionId);
    const index = typeof options === "number" ? options : options.index ?? options.slot ?? 0;
    if (!Number.isInteger(index) || index < 0) throw new RangeError("A keybinding alias index must be a non-negative integer");
    const normalized = normalizeBinding(binding);
    if (!normalized) throw new TypeError("Cannot bind an unidentified key");
    const candidate = cloneBindings(this._bindings);
    if (index > candidate[actionId].length) throw new RangeError(`Alias index ${index} is out of range for ${actionId}`);
    if (index === candidate[actionId].length) candidate[actionId].push(normalized);
    else candidate[actionId][index] = normalized;
    candidate[actionId] = [...new Set(candidate[actionId])];
    return candidate;
  }

  _commit(candidate) {
    const normalized = normaliseBindingsMap(candidate);
    // No mutation happens until the whole proposed map passes conflict checks.
    assertNoBindingConflicts(normalized);
    this._bindings = normalized;
    this._rebuildLookup();
  }

  _assertAction(actionId) {
    if (!(actionId in this._bindings)) throw new RangeError(`Unknown keybinding action: ${actionId}`);
  }

  _rebuildLookup() {
    this._lookup = new Map();
    for (const [actionId, bindings] of Object.entries(this._bindings)) {
      for (const binding of bindings) this._lookup.set(binding, actionId);
    }
  }

  _dispatchAction(payload, context) {
    const actions = { ...this._actions, ...(context.actions ?? context.handlers ?? {}) };
    const handler = actions[payload.actionId];
    if (typeof handler === "function") {
      return { handled: wasHandled(handler(payload), true), source: "action-handler" };
    }
    const onAction = context.onAction ?? this._onAction;
    if (typeof onAction === "function") {
      return { handled: wasHandled(onAction(payload.actionId, payload), true), source: "dispatcher" };
    }
    return { handled: false, reason: "unhandled-action" };
  }

  _dispatchEscape(payload, context) {
    const escape = { ...this._escape, ...(context.escape ?? {}) };
    for (const tier of ["cancel", "chooser", "closePanel"]) {
      if (typeof escape[tier] === "function" && wasHandled(escape[tier](payload), false)) {
        return { handled: true, escapeTier: tier };
      }
    }
    if (typeof escape.pause === "function") {
      return { handled: wasHandled(escape.pause(payload), true), escapeTier: "pause" };
    }
    return this._dispatchAction(payload, context);
  }
}
