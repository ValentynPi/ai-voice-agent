const LAT = 39.9864;
const LON = -0.0513;
const TIMEZONE = "Europe/Madrid";
const TTL_MS = 5 * 60 * 1000;

const WMO = {
  0: ["clear", "despejado"],
  1: ["mainly clear", "mayormente despejado"],
  2: ["partly cloudy", "parcialmente nublado"],
  3: ["overcast", "cubierto"],
  45: ["foggy", "con niebla"],
  48: ["rime fog", "niebla con escarcha"],
  51: ["light drizzle", "llovizna débil"],
  53: ["drizzle", "llovizna"],
  55: ["heavy drizzle", "llovizna fuerte"],
  61: ["light rain", "lluvia débil"],
  63: ["rain", "lluvia"],
  65: ["heavy rain", "lluvia fuerte"],
  71: ["light snow", "nieve débil"],
  73: ["snow", "nieve"],
  75: ["heavy snow", "nieve fuerte"],
  80: ["rain showers", "chubascos"],
  81: ["rain showers", "chubascos"],
  82: ["heavy rain showers", "chubascos fuertes"],
  95: ["thunderstorm", "tormenta"],
  96: ["thunderstorm with hail", "tormenta con granizo"],
  99: ["thunderstorm with hail", "tormenta con granizo"],
};

let cache = null;

export function conditionFromCode(code) {
  const pair = WMO[code] || ["unknown conditions", "condiciones desconocidas"];
  return { en: pair[0], es: pair[1], code };
}

export function mapPayload(payload, retrievedAt) {
  const current = payload.current || {};
  const daily = payload.daily || {};
  const days = (daily.time || []).map((date, index) => ({
    date,
    highC: daily.temperature_2m_max?.[index] ?? null,
    lowC: daily.temperature_2m_min?.[index] ?? null,
    precipChancePct: daily.precipitation_probability_max?.[index] ?? null,
    condition: conditionFromCode(daily.weather_code?.[index]),
  }));

  return {
    location: "Castellón de la Plana",
    latitude: LAT,
    longitude: LON,
    timezone: TIMEZONE,
    source: "open-meteo",
    retrievedAt,
    current: {
      observedAt: current.time || null,
      temperatureC: current.temperature_2m ?? null,
      apparentTemperatureC: current.apparent_temperature ?? null,
      humidityPct: current.relative_humidity_2m ?? null,
      windKmh: current.wind_speed_10m ?? null,
      condition: conditionFromCode(current.weather_code),
    },
    days,
  };
}

async function loadForecast() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(LAT));
  url.searchParams.set("longitude", String(LON));
  url.searchParams.set(
    "current",
    "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
  );
  url.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
  );
  url.searchParams.set("forecast_days", "4");
  url.searchParams.set("timezone", TIMEZONE);

  const response = await fetch(url, {
    headers: { "User-Agent": "ai-voice-agent-demo/1.0 (Maison Sol receptionist demo)" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    if (cache) return cache.data;
    throw new Error("Weather service unavailable");
  }
  const payload = await response.json();
  const data = mapPayload(payload, new Date().toISOString());
  cache = { at: Date.now(), data };
  return data;
}

export async function getWeather() {
  const data = await loadForecast();
  return {
    location: data.location,
    timezone: data.timezone,
    source: data.source,
    retrievedAt: data.retrievedAt,
    ...data.current,
  };
}

export async function getForecast({ days } = {}) {
  const data = await loadForecast();
  const count = clampDays(days);
  return {
    location: data.location,
    timezone: data.timezone,
    source: data.source,
    retrievedAt: data.retrievedAt,
    days: data.days.slice(0, count),
  };
}

function clampDays(days) {
  const n = Number(days);
  if (!Number.isFinite(n)) return 4;
  return Math.min(4, Math.max(1, Math.round(n)));
}

export function __clearWeatherCache() {
  cache = null;
}
