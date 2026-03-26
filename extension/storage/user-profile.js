// storage/user-profile.js — Persistent user profile stored in chrome.storage.local.
// Used by the form-fill skill to pre-populate known fields without asking the user each time.

const PROFILE_KEY = "user_profile";

/**
 * Load the full user profile. Returns an empty object if nothing is saved yet.
 */
export async function getUserProfile() {
  try {
    const result = await chrome.storage.local.get(PROFILE_KEY);
    return result[PROFILE_KEY] || {};
  } catch (e) {
    console.warn("user-profile: failed to load", e);
    return {};
  }
}

/**
 * Save or update profile fields. Deep-merges into the existing stored object.
 * Pass only the fields you want to add/update.
 */
export async function saveProfileFields(fields) {
  try {
    const existing = await getUserProfile();
    const updated = { ...existing, ...fields };
    await chrome.storage.local.set({ [PROFILE_KEY]: updated });
    return updated;
  } catch (e) {
    console.warn("user-profile: failed to save", e);
  }
}

/**
 * Format the user profile as a compact, human-readable string for injection into
 * the vision agent's goal prompt. Includes both well-known fields and any
 * arbitrary keys saved by the form-fill skill.
 *
 * Example output:
 * "Name: Suhaan Agarwal | Email: suhaan@example.com | portfolio_url: https://..."
 */
export function formatProfileForAgent(profile) {
  if (!profile || typeof profile !== "object") return "";

  // Well-known fields shown with friendly labels
  const LABEL_MAP = {
    fullName:     "Name",
    firstName:    "First name",
    lastName:     "Last name",
    email:        "Email",
    phone:        "Phone",
    dateOfBirth:  "Date of birth",
    gender:       "Gender",
    addressLine1: "Address line 1",
    addressLine2: "Address line 2",
    city:         "City",
    state:        "State",
    pincode:      "Pincode",
    country:      "Country",
    fatherName:   "Father's name",
    motherName:   "Mother's name",
    occupation:   "Occupation",
    company:      "Company",
    website:      "Website",
    linkedin:     "LinkedIn URL",
    linkedinUrl:  "LinkedIn URL",
    github:       "GitHub URL",
    githubUrl:    "GitHub URL",
  };

  const knownKeys = new Set(Object.keys(LABEL_MAP));
  const parts = [];

  // Well-known fields first
  for (const [key, label] of Object.entries(LABEL_MAP)) {
    if (profile[key]) parts.push(`${label}: ${profile[key]}`);
  }

  // Arbitrary fields saved by form-fill skill (skip internal chrome storage keys)
  for (const [key, value] of Object.entries(profile)) {
    if (!knownKeys.has(key) && value && typeof value === "string") {
      // Convert snake_case keys to readable labels
      const label = key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      parts.push(`${label}: ${value}`);
    }
  }

  return parts.join(" | ");
}
