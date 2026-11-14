import { conditionFromCode } from "../tools/weather.js";

const AIRPORT_FEATURES = new Set(["AIRP", "AIRF", "AIRB", "AIRS"]);
const AIRPORT_WORD = /airport|aerodrome|airfield|airstrip|аеродром|аеропорт|aeropuerto/i;
const STOP = new Set([
  "de", "la", "del", "los", "las", "the", "of", "da", "do", "di", "el", "al",
  "y", "and", "des", "du", "van", "von", "st",
]);

export function foldPlace(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ё/g, "е")
    .toLowerCase()
    .replace(/[^a-z0-9\u0400-\u04ff]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}


const CYRILLIC = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", ё: "e", є: "e", ж: "zh",
  з: "z", и: "i", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh",
  щ: "sh", ь: "", ы: "i", ъ: "", э: "e", ю: "u", я: "a",
};

/** Match place names across Ukrainian, Russian, and Spanish spellings. */
export function phoneticFold(value) {
  const base = foldPlace(value);
  let latin = "";
  for (const ch of base) latin += CYRILLIC[ch] ?? ch;
  return latin
    .replace(/ll/g, "l")
    .replace(/c/g, "k")
    .replace(/y/g, "i")
    .replace(/(.)\1+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalPlaceQuery(query) {
  const phone = phoneticFold(query);
  if (phone.includes("kastelon")) return "Castellón de la Plana";
  return "";
}

function tokens(value) {
  return phoneticFold(value).split(" ").filter((token) => token.length >= 4 && !STOP.has(token));
}

export function isPlaceSearchName(name) {
  return /search_locations|geocode/i.test(String(name || ""));
}

export function forecastToolFor(searchName) {
  const name = String(searchName || "");
  if (/search_locations/i.test(name)) return name.replace(/search_locations/i, "get_forecast");
  return "";
}

function placeBlob(place) {
  return foldPlace([place?.name, place?.admin1, place?.admin2, place?.country, place?.country_code].filter(Boolean).join(" "));
}

function overlaps(query, place) {
  const queryTokens = tokens(query);
  const blob = phoneticFold(placeBlob(place));
  const name = phoneticFold(place?.name);
  if (!queryTokens.length) {
    const folded = phoneticFold(query);
    return folded.length >= 3 && (name === folded || name.startsWith(`${folded} `) || folded.startsWith(`${name} `));
  }
  if (queryTokens.some((token) => blob.includes(token))) return true;
  const nameTokens = tokens(place?.name).filter((token) => !AIRPORT_WORD.test(token));
  const queryBlob = phoneticFold(query);
  return nameTokens.some((token) => queryBlob.includes(token));
}

export function isAirportPlace(place) {
  const feature = String(place?.feature_code || "").toUpperCase();
  return AIRPORT_FEATURES.has(feature) || AIRPORT_WORD.test(place?.name || "");
}

export function placesFromPresented(presented) {
  const structured = presented?.structured || presented?.structuredContent;
  if (Array.isArray(structured?.results) && structured.results.length) return structured.results;
  return parsePlaceText(presented?.text || "");
}

export function parsePlaceText(text) {
  const places = [];
  const block = String(text || "");
  const re = /\*\*(.+?)\*\*\s+\(([A-Za-z]{2})\)\s+[—-]\s+(.+?)\s+[—-]\s+(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/g;
  let match;
  while ((match = re.exec(block))) {
    const region = match[3].split(",").map((part) => part.trim());
    const tail = block.slice(match.index, match.index + 500);
    const feature = tail.match(/feature:\s*([A-Z0-9]+)/)?.[1] || "";
    const population = tail.match(/pop\.\s*([\d,]+)/)?.[1];
    places.push({
      name: match[1],
      country_code: match[2],
      country: region[0] || "",
      admin1: region[1] || "",
      admin2: region[2] || "",
      latitude: Number(match[4]),
      longitude: Number(match[5]),
      feature_code: feature,
      population: population ? Number(population.replace(/,/g, "")) : null,
      timezone: tail.match(/timezone:\s*([A-Za-z0-9_./+-]+)/)?.[1] || "",
    });
  }
  return places;
}

/**
 * Use a populated place that matches the request.
 * An airport of that same city is close enough.
 * Anything else is a different place and should be clarified.
 */
export function choosePlace(query, places) {
  const list = (Array.isArray(places) ? places : []).filter((place) => (
    Number.isFinite(Number(place?.latitude)) && Number.isFinite(Number(place?.longitude))
  ));
  if (!list.length) return { action: "clarify", reason: "no-place", airport: false, place: null };
  const ranked = list.map((place) => ({
    place,
    airport: isAirportPlace(place),
    overlap: overlaps(query, place),
    population: Number(place.population) || 0,
  }));
  const cities = ranked.filter((row) => row.overlap && !row.airport);
  if (cities.length) {
    cities.sort((a, b) => b.population - a.population);
    return { action: "use", reason: "city", airport: false, place: cities[0].place };
  }
  const airports = ranked.filter((row) => row.overlap && row.airport);
  if (airports.length) {
    return { action: "use", reason: "airport", airport: true, place: airports[0].place };
  }
  return { action: "clarify", reason: "different-place", airport: false, place: list[0] };
}

export function currentFacts(presented) {
  const current = presented?.structured?.current || presented?.structuredContent?.current;
  if (!current || typeof current.temperature_2m !== "number") return null;
  const units = presented?.structured?.current_units || presented?.structuredContent?.current_units || {};
  const condition = conditionFromCode(current.weather_code);
  return {
    time: current.time || null,
    temperature: current.temperature_2m,
    temperatureUnit: units.temperature_2m || "°C",
    weatherCode: current.weather_code ?? null,
    condition: condition.en,
    wind: typeof current.wind_speed_10m === "number" ? current.wind_speed_10m : null,
    windUnit: units.wind_speed_10m || "km/h",
    humidity: typeof current.relative_humidity_2m === "number" ? current.relative_humidity_2m : null,
    precipitation: typeof current.precipitation === "number" ? current.precipitation : null,
    precipitationUnit: units.precipitation || "mm",
  };
}

/** Per-day records ({ time, temperature_2m_max, ... }) from openmeteo_get_forecast daily_variables. */
export function dailyFacts(presented) {
  const daily = presented?.structured?.daily || presented?.structuredContent?.daily;
  const units = presented?.structured?.daily_units || presented?.structuredContent?.daily_units || {};
  if (!Array.isArray(daily)) return [];
  return daily.slice(0, 4).map((day) => {
    if (!day || typeof day !== "object" || !day.time) return null;
    const num = (key) => (typeof day[key] === "number" ? day[key] : null);
    return {
      date: String(day.time),
      high: num("temperature_2m_max"),
      low: num("temperature_2m_min"),
      temperatureUnit: units.temperature_2m_max || "°C",
      rainChance: num("precipitation_probability_max"),
      precipitation: num("precipitation_sum"),
      precipitationUnit: units.precipitation_sum || "mm",
      wind: num("wind_speed_10m_max"),
      windUnit: units.wind_speed_10m_max || "km/h",
      weatherCode: num("weather_code"),
      condition: day.weather_code == null ? null : conditionFromCode(day.weather_code).en,
    };
  }).filter((day) => day && (day.high != null || day.low != null || day.condition));
}

function formatDay(day) {
  const parts = [];
  if (day.condition) parts.push(day.condition);
  if (day.high != null) parts.push(`high ${day.high} ${day.temperatureUnit}`);
  if (day.low != null) parts.push(`low ${day.low} ${day.temperatureUnit}`);
  if (day.rainChance != null) parts.push(`rain chance ${day.rainChance}%`);
  if (day.precipitation != null) parts.push(`precipitation ${day.precipitation} ${day.precipitationUnit}`);
  if (day.wind != null) parts.push(`max wind ${day.wind} ${day.windUnit}`);
  return `${day.date}: ${parts.join(", ")}`;
}

function formatFacts(facts) {
  const parts = [
    `temperature ${facts.temperature} ${facts.temperatureUnit}`.trim(),
    `${facts.condition} (weather_code ${facts.weatherCode})`,
  ];
  if (facts.wind != null) parts.push(`wind ${facts.wind} ${facts.windUnit}`.trim());
  if (facts.humidity != null) parts.push(`humidity ${facts.humidity}%`);
  if (facts.precipitation != null) parts.push(`precipitation ${facts.precipitation} ${facts.precipitationUnit}`.trim());
  if (facts.time) parts.push(`observed ${facts.time}`);
  return parts.join(", ");
}

export function shapePlaceSearch({ query, presented, weather = null }) {
  const decision = choosePlace(query, placesFromPresented(presented));
  if (decision.action !== "use") {
    const text = `The places found for "${query}" are a different place, not the city asked for. Ask one short clarifying question. Do not invent the weather.`;
    return {
      text,
      isError: false,
      content: [{ type: "text", text }],
      structured: { accepted: false, clarify: true },
    };
  }
  const facts = currentFacts(weather);
  const place = decision.place;
  const where = [place.name, place.admin2, place.admin1, place.country].filter(Boolean).join(", ");
  if (!facts) {
    // The place is right; the forecast service did not answer. Say so once instead of retrying.
    const text = `I can't get the weather right now. The place was found (${where}), but the weather service is not answering. Tell the caller in one short sentence that the weather service isn't answering right now and to try again in a minute. Do not call the weather tools again in this reply and never invent the weather.`;
    return {
      text,
      isError: true,
      content: [{ type: "text", text }],
      structured: { accepted: true, weatherUnavailable: true },
    };
  }
  const lines = [
    `Place: ${where}.`,
    `Coordinates: ${place.latitude}, ${place.longitude}.`,
  ];
  if (decision.airport) {
    lines.push(`This airport is in the city the caller named ("${query}"). It is the right point. Speak the weather. Do not ask for another place and do not treat the airport as a mismatch.`);
  } else {
    lines.push(`This is the city the caller named ("${query}"). Speak the weather. Do not ask for clarification.`);
  }
  lines.push(`Current conditions from the weather tool: ${formatFacts(facts)}.`);
  const days = dailyFacts(weather);
  if (days.length) lines.push(`Daily forecast from the weather tool (local dates): ${days.map(formatDay).join("; ")}.`);
  const text = lines.join(" ");
  return {
    text,
    isError: false,
    content: [{ type: "text", text }],
    structured: {
      accepted: true,
      airport: decision.airport,
      place: {
        name: place.name,
        country: place.country || null,
        admin1: place.admin1 || null,
        admin2: place.admin2 || null,
        latitude: Number(place.latitude),
        longitude: Number(place.longitude),
        feature_code: place.feature_code || null,
      },
      current: facts,
      ...(days.length ? { daily: days } : {}),
    },
  };
}
