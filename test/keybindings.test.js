import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_KEYBINDINGS,
  KEYBINDING_SCHEMA_VERSION,
  KeybindingAction,
  KeybindingConflictError,
  KeybindingManager,
  bindingFromEvent,
  findBindingConflicts,
  isKeyboardCaptureTarget,
  normalizeBinding,
  serializeKeybindings,
} from "../src/core/keybindings.js";

function keyboardEvent(code, target = { tagName: "DIV" }, extra = {}) {
  return {
    code,
    key: code,
    target,
    defaultPrevented: false,
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
    ...extra,
  };
}

test("default Diablo-style bindings include aliases, one weapon set, and a dedicated portal key", () => {
  const manager = new KeybindingManager();
  assert.deepEqual(manager.getBindings(KeybindingAction.INVENTORY), ["KeyI", "KeyB"]);
  assert.deepEqual(manager.getBindings(KeybindingAction.CHARACTER), ["KeyC", "KeyA"]);
  assert.deepEqual(manager.getBindings(KeybindingAction.HIRELING), ["KeyO"]);
  assert.deepEqual(manager.getBindings(KeybindingAction.SKILLS), ["KeyT"]);
  assert.deepEqual(manager.getBindings(KeybindingAction.QUESTS), ["KeyQ"]);
  assert.deepEqual(manager.getBindings(KeybindingAction.MAP), ["Tab"]);
  assert.equal(manager.getActionForBinding("KeyW"), null);
  assert.deepEqual([1, 2, 3, 4].map((slot) => manager.getBindings(`beltSlot${slot}`)[0]), ["Digit1", "Digit2", "Digit3", "Digit4"]);
  assert.deepEqual(manager.getBindings(KeybindingAction.TOWN_PORTAL), ["KeyP"]);
  assert.deepEqual(manager.getBindings(KeybindingAction.ESCAPE), ["Escape"]);
  assert.deepEqual(findBindingConflicts(DEFAULT_KEYBINDINGS), []);
});

test("both aliases dispatch the same inventory and character actions", () => {
  const invoked = [];
  const manager = new KeybindingManager({ onAction: (actionId) => invoked.push(actionId) });
  for (const code of ["KeyI", "KeyB", "KeyC", "KeyA"]) {
    const event = keyboardEvent(code);
    const result = manager.handleKeydown(event);
    assert.equal(result.handled, true);
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
  }
  assert.deepEqual(invoked, ["inventory", "inventory", "character", "character"]);
});

test("binding normalization accepts labels, chords, and KeyboardEvent-like values", () => {
  assert.equal(normalizeBinding("i"), "KeyI");
  assert.equal(normalizeBinding("shift+ctrl+i"), "Ctrl+Shift+KeyI");
  assert.equal(normalizeBinding("1"), "Digit1");
  assert.equal(bindingFromEvent({ code: "KeyP", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+KeyP");
});

test("remapping checks conflicts transactionally before changing the registry", () => {
  const manager = new KeybindingManager();
  const before = manager.serialize();
  assert.deepEqual(manager.canRemap(KeybindingAction.SKILLS, "i"), {
    ok: false,
    conflicts: [{ binding: "KeyI", actionIds: ["inventory", "skills"] }],
    bindings: { ...before.bindings, skills: ["KeyI"] },
  });
  assert.throws(() => manager.remap(KeybindingAction.SKILLS, "i"), (error) => {
    assert.ok(error instanceof KeybindingConflictError);
    assert.equal(error.code, "KEYBINDING_CONFLICT");
    assert.deepEqual(error.conflicts, [{ binding: "KeyI", actionIds: ["inventory", "skills"] }]);
    return true;
  });
  assert.deepEqual(manager.serialize(), before);

  manager.remap(KeybindingAction.SKILLS, "KeyS");
  assert.deepEqual(manager.getBindings(KeybindingAction.SKILLS), ["KeyS"]);
  assert.equal(manager.getActionForBinding("s"), KeybindingAction.SKILLS);
});

test("serialization round-trips aliases and validates before Storage.setItem", () => {
  const manager = new KeybindingManager();
  manager.remap(KeybindingAction.TOWN_PORTAL, "Ctrl+P");
  const serialized = manager.serialize();
  assert.equal(serialized.schemaVersion, KEYBINDING_SCHEMA_VERSION);
  const restored = KeybindingManager.deserialize(JSON.stringify(serialized));
  assert.deepEqual(restored.getAllBindings(), manager.getAllBindings());

  const writes = [];
  const storage = {
    setItem: (key, value) => writes.push([key, value]),
    getItem: () => writes[0]?.[1] ?? null,
  };
  manager.save(storage, "test.bindings");
  assert.equal(writes.length, 1);
  assert.deepEqual(KeybindingManager.load(storage, "test.bindings").getAllBindings(), manager.getAllBindings());

  assert.throws(() => serializeKeybindings({ inventory: ["KeyI"], skills: ["i"] }), KeybindingConflictError);
  assert.equal(writes.length, 1);
});

test("Escape resolves cancel, then panel close, then pause and stops after the first handled tier", () => {
  const calls = [];
  const manager = new KeybindingManager({
    escape: {
      cancel: () => { calls.push("cancel"); return true; },
      closePanel: () => { calls.push("closePanel"); return true; },
      pause: () => { calls.push("pause"); },
    },
  });
  let result = manager.handleKeydown(keyboardEvent("Escape"));
  assert.equal(result.escapeTier, "cancel");
  assert.deepEqual(calls, ["cancel"]);

  calls.length = 0;
  manager.setEscapeHandlers({
    cancel: () => { calls.push("cancel"); return false; },
    closePanel: () => { calls.push("closePanel"); return true; },
    pause: () => { calls.push("pause"); },
  });
  result = manager.handleKeydown(keyboardEvent("Escape"));
  assert.equal(result.escapeTier, "closePanel");
  assert.deepEqual(calls, ["cancel", "closePanel"]);

  calls.length = 0;
  manager.setEscapeHandlers({
    cancel: () => { calls.push("cancel"); return false; },
    closePanel: () => { calls.push("closePanel"); return false; },
    pause: () => { calls.push("pause"); },
  });
  result = manager.handleKeydown(keyboardEvent("Escape"));
  assert.equal(result.escapeTier, "pause");
  assert.deepEqual(calls, ["cancel", "closePanel", "pause"]);
});

test("Escape closes an open chooser before panel close and pause", () => {
  const calls = [];
  const manager = new KeybindingManager({
    escape: {
      cancel: () => { calls.push("cancel"); return false; },
      chooser: () => { calls.push("chooser"); return true; },
      closePanel: () => { calls.push("closePanel"); return true; },
      pause: () => { calls.push("pause"); },
    },
  });
  const result = manager.handleKeydown(keyboardEvent("Escape"));
  assert.equal(result.escapeTier, "chooser");
  assert.deepEqual(calls, ["cancel", "chooser"]);
});

test("typing fields, editable descendants, and console areas never dispatch shortcuts", () => {
  let dispatches = 0;
  const manager = new KeybindingManager({ onAction: () => { dispatches += 1; } });
  const targets = [
    { tagName: "INPUT" },
    { tagName: "textarea" },
    { tagName: "SELECT" },
    { tagName: "DIV", isContentEditable: true },
    { tagName: "DIV", id: "console" },
    { tagName: "SPAN", parentElement: { tagName: "DIV", className: "game-console" } },
    { tagName: "SPAN", parentElement: { tagName: "DIV", dataset: { keyboardScope: "console" } } },
  ];
  for (const target of targets) {
    assert.equal(isKeyboardCaptureTarget(target), true);
    const event = keyboardEvent("KeyI", target);
    assert.equal(manager.handleKeydown(event).handled, false);
    assert.equal(event.prevented, false);
  }
  assert.equal(dispatches, 0);
});

test("ordinary DOM nodes with inherited contentEditable do not swallow shortcuts", () => {
  let dispatches = 0;
  const manager = new KeybindingManager({ onAction: () => { dispatches += 1; } });
  const body = {
    tagName: "BODY",
    contentEditable: "inherit",
    hasAttribute: () => false,
    getAttribute: () => null,
  };
  const event = keyboardEvent("KeyI", body);
  assert.equal(isKeyboardCaptureTarget(body), false);
  assert.equal(manager.handleKeydown(event).handled, true);
  assert.equal(dispatches, 1);
  assert.equal(event.prevented, true);
});

test("attach returns an isolated cleanup and ignores key-repeat events", () => {
  const listeners = new Map();
  const target = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type); },
  };
  let count = 0;
  const manager = new KeybindingManager({ actions: { inventory: () => { count += 1; } } });
  const detach = manager.attach(target);
  listeners.get("keydown")(keyboardEvent("KeyI"));
  listeners.get("keydown")(keyboardEvent("KeyI", { tagName: "DIV" }, { repeat: true }));
  assert.equal(count, 1);
  assert.equal(detach(), true);
  assert.equal(listeners.has("keydown"), false);
  assert.equal(detach(), false);
});
