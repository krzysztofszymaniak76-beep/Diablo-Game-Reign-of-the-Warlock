import { HERO_FIGURE_SHEET, HERO_VISUALS } from "../src/core/hero-visuals.js";

export const DEFAULT_GENDER_BY_CLASS = Object.freeze({
  amazon: "female",
  assassin: "female",
  barbarian: "male",
  druid: "male",
  necromancer: "male",
  paladin: "male",
  sorceress: "female",
  warlock: "male",
});

export const ALTERNATE_CHARACTER_SPRITES = Object.freeze({
  "amazon:male": "/app/assets/unit-amazon-male-v1.png",
  "assassin:male": "/app/assets/unit-assassin-male-v1.png",
  "barbarian:female": "/app/assets/unit-barbarian-female-v1.png",
  "druid:female": "/app/assets/unit-druid-female-v1.png",
  "necromancer:female": "/app/assets/unit-necromancer-female-v1.png",
  "paladin:female": "/app/assets/unit-paladin-female-v1.png",
  "sorceress:male": "/app/assets/unit-sorceress-male-v1.png",
  "warlock:female": "/app/assets/unit-warlock-female-v1.png",
});

export function spriteKeyForGender(classId, gender) {
  if (!Object.hasOwn(DEFAULT_GENDER_BY_CLASS, classId)) throw new RangeError(`Unknown class: ${classId}`);
  if (gender !== "male" && gender !== "female") throw new RangeError(`Unknown gender: ${gender}`);
  return gender === DEFAULT_GENDER_BY_CLASS[classId] ? classId : `${classId}:${gender}`;
}

export function normalizeCreationProfile(value) {
  if (value == null) return { schemaVersion: 1, mode: "normal", genders: {} };
  if (typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1
    || !["normal", "hardcore"].includes(value.mode)
    || !value.genders || typeof value.genders !== "object" || Array.isArray(value.genders)) {
    throw new TypeError("Nieprawidłowy profil tworzenia postaci");
  }
  const genders = {};
  for (const [heroId, gender] of Object.entries(value.genders)) {
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(heroId) || !["male", "female"].includes(gender)) {
      throw new TypeError("Nieprawidłowy wygląd postaci w zapisie");
    }
    genders[heroId] = gender;
  }
  return { schemaVersion: 1, mode: value.mode, genders };
}

// Pixel rectangles in the transparent, 1672×941 figure layer. Each character
// is cropped from the same source so choosing one never duplicates the figure
// already present in the background.
export function createCharacterCreation({ definitions, classNames, gameShell, onConfirm, onBack }) {
  const root = document.querySelector("#character-creation");
  const classes = document.querySelector("#character-creation-classes");
  const selection = document.querySelector("#character-creation-selection");
  const status = document.querySelector("#character-creation-status");
  const nameInput = document.querySelector("#character-creation-name");
  const normalButton = document.querySelector("#character-creation-normal");
  const hardcoreButton = document.querySelector("#character-creation-hardcore");
  const confirmButton = document.querySelector("#character-creation-confirm");
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  let selectedIds = [];
  let activeId = null;
  let mode = "normal";
  let names = {};
  let submitting = false;
  let previousShellState = null;

  function render() {
    for (const button of classes.querySelectorAll("button")) {
      const id = button.dataset.heroId;
      button.dataset.selected = String(selectedIds.includes(id));
      button.dataset.active = String(activeId === id);
      button.setAttribute("aria-pressed", String(selectedIds.includes(id)));
    }
    selection.textContent = selectedIds.length
      ? `Drużyna ${selectedIds.length}/3: ${selectedIds.map((id) => names[id] || byId.get(id).name).join(" · ")}`
      : "Wybierz 1–3 postacie, a następnie wpisz ich imiona.";
    const active = activeId ? byId.get(activeId) : null;
    nameInput.disabled = !active;
    nameInput.value = active ? (names[activeId] ?? active.name) : "";
    nameInput.placeholder = active ? "Wpisz imię" : "Wybierz postać";
    normalButton.setAttribute("aria-pressed", String(mode === "normal"));
    hardcoreButton.setAttribute("aria-pressed", String(mode === "hardcore"));
    confirmButton.disabled = selectedIds.length === 0 || submitting;
  }

  for (const definition of definitions) {
    const figure = HERO_VISUALS[definition.classId]?.rect;
    if (!figure) continue;
    const [x, y, width, height] = figure;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "character-creation-class";
    button.dataset.heroId = definition.id;
    button.setAttribute("aria-label", `Wybierz ${classNames[definition.classId]}`);
    button.setAttribute("aria-pressed", "false");
    button.style.left = `${100 * x / 1672}%`;
    button.style.top = `${100 * y / 941}%`;
    button.style.width = `${100 * width / 1672}%`;
    button.style.height = `${100 * height / 941}%`;
    button.style.setProperty("--sheet-width", `${100 * 1672 / width}%`);
    button.style.setProperty("--sheet-left", `${-100 * x / width}%`);
    button.style.setProperty("--sheet-top", `${-100 * y / height}%`);
    const crop = document.createElement("span");
    crop.className = "character-creation-figure-crop";
    const image = document.createElement("img");
    image.src = HERO_FIGURE_SHEET;
    image.alt = "";
    image.draggable = false;
    crop.append(image);
    const label = document.createElement("span");
    label.className = "character-creation-class-label";
    label.textContent = classNames[definition.classId];
    button.append(crop, label);
    button.addEventListener("click", () => {
      const index = selectedIds.indexOf(definition.id);
      if (index >= 0 && activeId === definition.id) {
        selectedIds.splice(index, 1);
        activeId = selectedIds.at(-1) ?? null;
      } else if (index >= 0) {
        activeId = definition.id;
      } else if (selectedIds.length < 3) {
        selectedIds.push(definition.id);
        activeId = definition.id;
      } else {
        status.textContent = "Możesz wybrać najwyżej trzy postacie.";
        return;
      }
      status.textContent = "";
      render();
      if (activeId) {
        nameInput.focus({ preventScroll: true });
        nameInput.select();
      }
    });
    classes.append(button);
  }

  nameInput.addEventListener("input", () => {
    if (activeId) {
      names[activeId] = nameInput.value;
      selection.textContent = `Drużyna ${selectedIds.length}/3: ${selectedIds.map((id) => names[id] || byId.get(id).name).join(" · ")}. Kliknij postać ponownie, aby ją usunąć.`;
    }
  });
  normalButton.addEventListener("click", () => { mode = "normal"; render(); });
  hardcoreButton.addEventListener("click", () => { mode = "hardcore"; render(); });
  document.querySelector("#character-creation-back").addEventListener("click", () => {
    hide();
    onBack?.();
  });
  confirmButton.addEventListener("click", async () => {
    if (selectedIds.length === 0 || submitting) return;
    const chosenNames = Object.fromEntries(selectedIds.map((id) => [id, (names[id] ?? byId.get(id).name).trim()]));
    if (Object.values(chosenNames).some((name) => name.length < 2 || name.length > 24
      || !/^[\p{L}\p{N}][\p{L}\p{N} -]*$/u.test(name))) {
      status.textContent = "Imię: 2–24 znaki; litery, cyfry, spacje lub myślnik.";
      return;
    }
    if (new Set(Object.values(chosenNames).map((name) => name.toLocaleLowerCase("pl"))).size !== selectedIds.length) {
      status.textContent = "Postacie w drużynie muszą mieć różne imiona.";
      return;
    }
    submitting = true;
    render();
    try {
      const created = await onConfirm({
        selectedIds: [...selectedIds],
        names: chosenNames,
        profile: normalizeCreationProfile({ schemaVersion: 1, mode, genders: {} }),
      });
      if (created === false) throw new Error("Nie udało się rozpocząć gry.");
      hide();
    } catch (error) {
      status.textContent = error.message || "Nie udało się stworzyć drużyny.";
    } finally {
      submitting = false;
      render();
    }
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      hide();
      onBack?.();
    }
    if (event.key === "Tab") {
      const controls = [...root.querySelectorAll("button:not([disabled]), input:not([disabled])")];
      if (event.shiftKey && document.activeElement === controls[0]) {
        event.preventDefault();
        controls.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
        event.preventDefault();
        controls[0]?.focus();
      }
    }
    event.stopPropagation();
  });

  function show() {
    selectedIds = [];
    activeId = null;
    mode = "normal";
    names = {};
    status.textContent = "";
    previousShellState = { inert: gameShell.inert, ariaHidden: gameShell.getAttribute("aria-hidden") };
    gameShell.inert = true;
    gameShell.setAttribute("aria-hidden", "true");
    root.hidden = false;
    root.setAttribute("aria-hidden", "false");
    render();
    classes.querySelector("button")?.focus({ preventScroll: true });
  }

  function hide() {
    root.hidden = true;
    root.setAttribute("aria-hidden", "true");
    if (previousShellState) {
      gameShell.inert = previousShellState.inert;
      if (previousShellState.ariaHidden === null) gameShell.removeAttribute("aria-hidden");
      else gameShell.setAttribute("aria-hidden", previousShellState.ariaHidden);
    }
    previousShellState = null;
  }

  render();
  return { show, hide, isVisible: () => !root.hidden };
}
