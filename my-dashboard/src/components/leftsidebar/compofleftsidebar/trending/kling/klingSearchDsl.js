const TOKEN_RE = /([a-zA-Z]+):("[^"]*"|'[^']*'|\S+)/g;

const DATE_KEYWORDS = new Set(['all', 'today', 'yesterday', 'week', 'month']);

function stripQuotes(value) {
  if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parses a Kling search-box query string for recognized key:value tokens
 * (department:, project:, model:, resolution:, status:/ownership:, tag:,
 * is:favorite / favorite:true, date:) and strips them out, leaving the
 * remainder as free text. Unrecognized keys (user:, owner:, prompt:, etc.)
 * are left in the free text since the backend already ilike-matches
 * prompt/model/owner name/project name against it.
 */
export function parseKlingQuery(rawInput) {
  const result = {
    freeText: '',
    department: undefined,
    project: undefined,
    model: undefined,
    resolution: undefined,
    ownershipStatus: undefined,
    tag: undefined,
    isFavorite: undefined,
    datePreset: undefined,
  };

  const input = `${rawInput || ''}`;
  let remainder = input;

  for (const match of input.matchAll(TOKEN_RE)) {
    const key = match[1].toLowerCase();
    const value = stripQuotes(match[2]).trim();
    if (!value) continue;

    let recognized = true;
    switch (key) {
      case 'department':
      case 'dept':
        result.department = value;
        break;
      case 'project':
        result.project = value;
        break;
      case 'model':
        result.model = value;
        break;
      case 'resolution':
        result.resolution = value;
        break;
      case 'status':
      case 'ownership':
        result.ownershipStatus = value.toLowerCase();
        break;
      case 'tag':
        result.tag = value;
        break;
      case 'favorite':
        result.isFavorite = /^(true|yes|1)$/i.test(value);
        break;
      case 'is':
        if (value.toLowerCase() === 'favorite') {
          result.isFavorite = true;
        } else {
          recognized = false;
        }
        break;
      case 'date':
        if (DATE_KEYWORDS.has(value.toLowerCase())) {
          result.datePreset = value.toLowerCase();
        } else {
          recognized = false;
        }
        break;
      default:
        recognized = false;
    }

    if (recognized) {
      remainder = remainder.replace(match[0], ' ');
    }
  }

  result.freeText = remainder.replace(/\s+/g, ' ').trim();
  return result;
}
