// skills/index.js — Single source of truth for all skills (built-in + community).
// The Orchestrator reads from this registry. Individual skill files are never imported directly elsewhere.

import formFill from "./form-fill.js";
import booking from "./booking.js";
import shopping from "./shopping.js";
import research from "./research.js";
import email from "./email.js";
import tabManager from "./tab-manager.js";
import media from "./media.js";

// Built-in skills — ordered (first semantic match wins on ambiguous intents)
const BUILT_IN_SKILLS = [
  booking,       // check before form-fill so "book a table" doesn't become form-fill
  shopping,
  email,
  media,
  research,
  tabManager,
  formFill,      // last: most generic
];

// Community skills loaded from chrome.storage.local
let communitySkills = [];

/**
 * Load community skills from storage. Call once at service worker startup.
 */
export async function initSkillRegistry() {
  try {
    const { communitySkillsData = [] } = await chrome.storage.local.get("communitySkillsData");
    communitySkills = communitySkillsData.map(({ code }) => {
      try {
        // Evaluate in a constrained scope — community skills are plain objects
        const mod = {};
        // eslint-disable-next-line no-new-func
        new Function("module", "exports", code)(mod, mod.exports = {});
        return mod.exports?.default || mod.exports;
      } catch {
        return null;
      }
    }).filter(s => s && typeof s.name === "string" && typeof s.description === "string");
  } catch (e) {
    console.warn("skills/index: failed to load community skills", e);
    communitySkills = [];
  }
}

/** All skills: built-ins first, then community. */
export function getAllSkills() {
  return [...BUILT_IN_SKILLS, ...communitySkills];
}

/** Lookup skill by exact name. Returns null if not found. */
export function getSkill(name) {
  if (!name) return null;
  return getAllSkills().find(s => s.name === name) ?? null;
}

/**
 * Skill manifest for the Orchestrator prompt — just name + description.
 * Keeps the prompt small; Orchestrator never needs full skill objects.
 */
export function getSkillManifest() {
  return getAllSkills().map(({ name, description }) => ({ name, description }));
}
