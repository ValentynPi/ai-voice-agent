import { receptionistInstructions } from "../src/realtime.js";
import assert from "node:assert/strict";
import test from "node:test";
import { toolFollowUpEvent } from "../public/js/realtime-turn.js";
import {
  canonicalPlaceQuery,
  choosePlace,
  shapePlaceSearch,
} from "../src/mcp/place-weather.js";

const AIRPORT_NOTICE = "Low-confidence match: the top result \"Castellón Aerodrome\" (Spain, feature_code AIRP) has no recorded population, below the 100,000 this tool reads as a confident city match. Verify the coordinates before passing them to a weather tool. If the query was a historic or colonial exonym, the index may hold no entry for it at all and has returned an unrelated feature — retry with the place’s current official name.";

function airportSearch() {
  return {
    text: `## Geocoding results for search\n**Castellón Aerodrome** (ES) — Spain, Valencia, Castellon — 39.99902, 0.02618\n  id: 8435668 | timezone: Europe/Madrid | feature: AIRP\n\n> ${AIRPORT_NOTICE}`,
    isError: false,
    structured: {
      results: [{
        id: 8435668,
        name: "Castellón Aerodrome",
        latitude: 39.99902,
        longitude: 0.02618,
        timezone: "Europe/Madrid",
        country: "Spain",
        country_code: "ES",
        admin1: "Valencia",
        admin2: "Castellon",
        population: null,
        feature_code: "AIRP",
      }],
      notice: AIRPORT_NOTICE,
    },
  };
}

const weather = {
  structured: {
    current: {
      time: "2026-10-03T15:15",
      temperature_2m: 23.1,
      weather_code: 3,
      wind_speed_10m: 19.1,
      relative_humidity_2m: 73,
      precipitation: 0,
    },
    current_units: {
      temperature_2m: "°C",
      weather_code: "wmo code",
      wind_speed_10m: "km/h",
      relative_humidity_2m: "%",
      precipitation: "mm",
    },
  },
};

test("Castellón de la Plana keeps the airport geocode and the tool's weather", () => {
  const decision = choosePlace("Castellón de la Plana", airportSearch().structured.results);
  assert.equal(decision.action, "use");
  assert.equal(decision.airport, true);
  assert.equal(decision.place.name, "Castellón Aerodrome");

  const shaped = shapePlaceSearch({
    query: "Castellon de la Plana",
    presented: airportSearch(),
    weather,
  });
  assert.equal(shaped.isError, false);
  assert.match(shaped.text, /23\.1 °C/);
  assert.match(shaped.text, /overcast/);
  assert.match(shaped.text, /weather_code 3/);
  assert.match(shaped.text, /airport/i);
  assert.doesNotMatch(shaped.text, /Verify the coordinates/i);
  assert.doesNotMatch(shaped.text, /Low-confidence/i);
  assert.doesNotMatch(shaped.text, /unrelated feature/i);
  assert.equal(shaped.structured.notice, undefined);
  assert.equal(shaped.structured.current.temperature, 23.1);
});

test("a Costa Azahar airport hit is the city weather point", () => {
  const decision = choosePlace("Castellón de la Plana", [{
    name: "Castellón–Costa Azahar Airport",
    latitude: 40.2097,
    longitude: 0.06972,
    country: "Spain",
    admin1: "Valencia",
    admin2: "Castellon",
    feature_code: "AIRP",
  }]);
  assert.equal(decision.action, "use");
  assert.equal(decision.airport, true);
});

test("a populated city beats an airport, and a different city is not accepted", () => {
  const decision = choosePlace("Castellon", [
    {
      name: "Castellón Aerodrome",
      latitude: 39.99,
      longitude: 0.02,
      admin2: "Castellon",
      country: "Spain",
      feature_code: "AIRP",
    },
    {
      name: "Castellon",
      latitude: 39.98567,
      longitude: -0.04935,
      admin1: "Valencia",
      admin2: "Castellon",
      country: "Spain",
      population: 171857,
      feature_code: "PPLA2",
    },
  ]);
  assert.equal(decision.airport, false);
  assert.equal(decision.place.feature_code, "PPLA2");

  const other = choosePlace("Barcelona", airportSearch().structured.results);
  assert.equal(other.action, "clarify");
  const shaped = shapePlaceSearch({ query: "Barcelona", presented: airportSearch(), weather });
  assert.equal(shaped.isError, false);
  assert.match(shaped.text, /different place/i);
  assert.doesNotMatch(shaped.text, /23\.1/);
  assert.doesNotMatch(shaped.text, /Verify the coordinates/i);
});

test("a failed forecast is a short weather failure, not a place refusal", () => {
  const shaped = shapePlaceSearch({
    query: "Castellón de la Plana",
    presented: airportSearch(),
    weather: null,
  });
  assert.equal(shaped.isError, true);
  assert.match(shaped.text, /can't get the weather right now/);
  assert.doesNotMatch(shaped.text, /airport/i);
  assert.doesNotMatch(shaped.text, /Verify the coordinates/i);
});

test("the spoken follow-up accepts an in-city airport", () => {
  const follow = toolFollowUpEvent("openmeteo_search_locations", false, "яка погода");
  assert.equal(follow.response.tool_choice, "none");
  assert.match(follow.response.instructions, /Speak the tool result/);
  // The airport rule lives in the cached session instructions (not per reply).
  assert.match(receptionistInstructions("en", { systemPrompt: "You report weather." }), /airport station counts as that city/i);
});

test("a Ukrainian Castellón question matches the city airport, not a refusal", () => {
  const query = "Кастельон-де-ла-Плана";
  const decision = choosePlace(query, airportSearch().structured.results);
  assert.equal(decision.action, "use");
  assert.equal(decision.airport, true);
  assert.equal(canonicalPlaceQuery(query), "Castellón de la Plana");
  const shaped = shapePlaceSearch({ query, presented: airportSearch(), weather });
  assert.match(shaped.text, /Кастельон-де-ла-Плана/);
  assert.match(shaped.text, /23\.1/);
  assert.doesNotMatch(shaped.text, /different place/i);
});
