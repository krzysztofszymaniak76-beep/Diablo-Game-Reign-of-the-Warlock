export class RunewordCatalog {
  constructor(recipes) {
    this.recipes = structuredClone(recipes);
    const ids = new Set();
    for (const recipe of this.recipes) {
      if (ids.has(recipe.id)) throw new Error(`Duplicate runeword id: ${recipe.id}`);
      ids.add(recipe.id);
    }
  }

  match(item) {
    if (item.runeword) return null;
    if (!Array.isArray(item.sockets) || item.sockets.some((socket) => typeof socket !== "string")) return null;
    return this.recipes.find((recipe) =>
      recipe.socketableType === item.socketableType &&
      recipe.socketCount === item.sockets.length &&
      recipe.allowedQualities.includes(item.quality) &&
      recipe.runes.every((rune, index) => rune === item.sockets[index])
    ) ?? null;
  }

  activate(item, rolledProperties = null) {
    if (item.runeword) return item.runeword;
    const recipe = this.match(item);
    if (!recipe) return null;
    if (recipe.propertiesStatus !== "VERIFIED" && rolledProperties !== null) {
      throw new Error("Cannot attach properties to an unverified runeword record");
    }
    item.runeword = {
      recipeId: recipe.id,
      nameEn: recipe.nameEn,
      namePl: recipe.namePl,
      rolledProperties: structuredClone(rolledProperties),
      rolledOnce: true,
      dataStatus: recipe.propertiesStatus,
    };
    return item.runeword;
  }
}
