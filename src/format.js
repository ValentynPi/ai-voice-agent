const WEEKDAY = { en: "en-GB", es: "es-ES" };

export function detectLang(text) {
  const sample = String(text ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
  const es = sample.match(/\b(el|la|los|las|que|hola|gracias|cita|citas|clima|tiempo|manana|hoy|pedido|horario|por favor|dia)\b/g)?.length || 0;
  const en = sample.match(/\b(the|what|weather|hello|thanks|appointment|today|tomorrow|order|hours|please|your)\b/g)?.length || 0;
  return es > en ? "es" : "en";
}

function round(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function speakDate(iso, lang) {
  if (!iso) return "";
  const date = new Date(`${iso}T12:00:00`);
  return new Intl.DateTimeFormat(WEEKDAY[lang] || "en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/Madrid",
  }).format(date);
}

function euros(amount, lang) {
  const n = round(amount);
  if (n == null) return lang === "es" ? "precio no indicado" : "an unlisted price";
  return lang === "es" ? `${n} euros` : `${n} euros`;
}

function joinSentences(parts) {
  return parts.filter(Boolean).join(" ");
}

function weatherSentence(result, lang) {
  const temp = round(result.temperatureC);
  const feels = round(result.apparentTemperatureC);
  const humidity = round(result.humidityPct);
  const wind = round(result.windKmh);
  const condition = result.condition?.[lang] || result.condition?.en || "unknown";
  if (temp == null) {
    return lang === "es"
      ? "No he podido leer el tiempo de Castellón ahora mismo."
      : "I could not read the Castellón weather just now.";
  }
  const windEn = wind === 1 ? "1 kilometer" : `${wind} kilometers`;
  const windEs = wind === 1 ? "1 kilómetro" : `${wind} kilómetros`;
  if (lang === "es") {
    return `En Castellón de la Plana hay ${temp} grados y está ${condition}. Sensación de ${feels} grados, humedad del ${humidity} por ciento y viento de ${windEs} por hora.`;
  }
  return `In Castellón de la Plana it is ${temp} degrees and ${condition}. It feels like ${feels} degrees, humidity is ${humidity} percent, and the wind is ${windEn} per hour.`;
}

function forecastSentence(result, lang) {
  const days = result.days || [];
  if (!days.length) {
    return lang === "es"
      ? "No tengo la previsión de Castellón ahora mismo."
      : "I do not have the Castellón forecast right now.";
  }
  const bits = days.map((day) => {
    const label = speakDate(day.date, lang);
    const condition = day.condition?.[lang] || day.condition?.en;
    const high = round(day.highC);
    const low = round(day.lowC);
    if (lang === "es") return `${label}: máxima ${high}, mínima ${low}, ${condition}.`;
    return `${label}: high ${high}, low ${low}, ${condition}.`;
  });
  const lead = lang === "es" ? "Previsión para Castellón de la Plana." : "Castellón de la Plana forecast.";
  return `${lead} ${bits.join(" ")}`;
}

function orderSentence(order, lang) {
  if (lang === "es") {
    const when = `${speakDate(order.date, lang)} a las ${order.time}`;
    return `El pedido ${order.id} de ${order.customer} está ${statusEs(order.status)}. ${order.service} con ${order.stylist}, ${when}. Total ${euros(order.totalEur, lang)}.`;
  }
  const when = `${speakDate(order.date, lang)} at ${order.time}`;
  return `Order ${order.id} for ${order.customer} is ${order.status}. ${order.service} with ${order.stylist}, ${when}. Total ${euros(order.totalEur, lang)}.`;
}

function statusEs(status) {
  if (status === "confirmed") return "confirmado";
  if (status === "pending") return "pendiente";
  if (status === "completed") return "completado";
  return status;
}

function customerSentence(customer, lang, userText) {
  const wantsContact = /\b(phone|email|tel[eé]fono|correo|n[uú]mero)\b/i.test(userText);
  const next = customer.nextAppointment;
  if (lang === "es") {
    const visit = next
      ? `La próxima cita es el ${speakDate(next.date, lang)} a las ${next.time}, ${next.service} con ${next.stylist}.`
      : "No tiene próxima cita.";
    const contact = wantsContact ? ` Teléfono ${customer.phone}. Correo ${customer.email}.` : "";
    return `${customer.name} es cliente ${customer.loyalty}. ${visit} Nota: ${customer.notes}${contact}`;
  }
  const visit = next
    ? `Next appointment is ${speakDate(next.date, lang)} at ${next.time} for ${next.service} with ${next.stylist}.`
    : "There is no upcoming appointment.";
  const contact = wantsContact ? ` Phone ${customer.phone}. Email ${customer.email}.` : "";
  return `${customer.name} is a ${customer.loyalty} client. ${visit} Note: ${customer.notes}${contact}`;
}

function hoursSentence(result, lang) {
  if (lang === "es") {
    return "Abrimos de martes a sábado, de 10 de la mañana a 8 de la tarde. Lunes y domingo, cerrado. Estamos en Castellón de la Plana.";
  }
  return "We are open Tuesday through Saturday, from 10 in the morning until 8 in the evening. Closed Sunday and Monday. The salon is in Castellón de la Plana.";
}

function servicesSentence(result, lang) {
  const services = result.services || [];
  if (!services.length) {
    return lang === "es" ? "No encuentro ese servicio." : "I cannot find that service.";
  }
  const bits = services.slice(0, 4).map((service) => {
    if (lang === "es") return `${service.name}, ${service.priceEur} euros`;
    return `${service.name} for ${service.priceEur} euros`;
  });
  if (lang === "es") return `Estos son algunos servicios: ${bits.join("; ")}.`;
  return `Here are some services: ${bits.join("; ")}.`;
}

function staffSentence(result, lang) {
  const people = (result.staff || []).map((person) => `${person.name}, ${person.role}`);
  if (lang === "es") return `El equipo es ${people.join("; ")}.`;
  return `The team is ${people.join("; ")}.`;
}

function appointmentsSentence(result, lang) {
  const items = result.appointments || [];
  if (!items.length) {
    return lang === "es" ? "No hay citas próximas." : "There are no upcoming appointments.";
  }
  const bits = items.map((item) => {
    if (lang === "es") {
      return `${item.customer}, ${speakDate(item.date, lang)} a las ${item.time}, ${item.service}`;
    }
    return `${item.customer} on ${speakDate(item.date, lang)} at ${item.time} for ${item.service}`;
  });
  if (lang === "es") return `Citas próximas: ${bits.join(". ")}.`;
  return `Upcoming appointments: ${bits.join(". ")}.`;
}

function ordersListSentence(result, lang) {
  const orders = result.orders || [];
  if (!orders.length) {
    return lang === "es" ? "No hay pedidos con ese filtro." : "There are no orders for that filter.";
  }
  const bits = orders.map((order) => `${order.id} ${order.customer} ${order.status}`);
  if (lang === "es") return `Pedidos de demostración: ${bits.join("; ")}.`;
  return `Demo orders: ${bits.join("; ")}.`;
}

export function speakToolResult(name, payload, lang, userText) {
  if (!payload?.ok) {
    const error = payload?.result?.error;
    if (lang === "es") return error ? `No he podido usar ${name}. ${error}` : `No he podido usar ${name}.`;
    return error ? `I could not use ${name}. ${error}` : `I could not use ${name}.`;
  }
  const result = payload.result || {};
  if (name === "get_weather") return weatherSentence(result, lang);
  if (name === "get_forecast") return forecastSentence(result, lang);
  if (name === "get_order") {
    if (!result.found) {
      const ids = (result.knownIds || []).join(", ");
      return lang === "es"
        ? `No encuentro ese pedido. Tengo ${ids}.`
        : `I cannot find that order. I have ${ids}.`;
    }
    return orderSentence(result.order, lang);
  }
  if (name === "list_orders") return ordersListSentence(result, lang);
  if (name === "lookup_customer") {
    if (!result.found) {
      const names = (result.customers || []).join(", ");
      return lang === "es"
        ? `No encuentro a esa persona. En el libro están ${names}.`
        : `I cannot find that client. The book has ${names}.`;
    }
    return customerSentence(result.customer, lang, userText);
  }
  if (name === "list_appointments") return appointmentsSentence(result, lang);
  if (name === "query_services") return servicesSentence(result, lang);
  if (name === "query_staff") return staffSentence(result, lang);
  if (name === "query_hours") return hoursSentence(result, lang);
  return lang === "es" ? "Hecho." : "Done.";
}

export function refusal(lang) {
  if (lang === "es") {
    return "No puedo hacer eso. Puedo ayudarte con el tiempo en Castellón, citas, pedidos o los servicios del salón.";
  }
  return "I can't do that. I can help with the Castellón weather, appointments, orders, or salon services.";
}

export function smallTalk(text, lang) {
  const n = text.toLowerCase();
  if (/\b(hi|hello|hey|hola|buenos d[ií]as|buenas)\b/.test(n)) {
    return lang === "es"
      ? "Hola, soy Sol, la recepción de Maison Sol en Castellón. ¿Quieres el tiempo, una cita, un pedido o los horarios?"
      : "Hello, this is Sol at Maison Sol in Castellón. I can check the weather, an appointment, an order, or our hours.";
  }
  if (/\b(thanks|thank you|gracias)\b/.test(n)) {
    return lang === "es" ? "De nada. ¿Algo más?" : "You're welcome. Anything else?";
  }
  if (/\b(how are you|qu[eé] tal|c[oó]mo est[aá]s)\b/.test(n)) {
    return lang === "es"
      ? "Bien, gracias. Lista para ayudarte con el salón."
      : "I'm well, thank you. Ready to help with the salon.";
  }
  return lang === "es"
    ? "Puedo mirar el tiempo en Castellón, citas, pedidos, servicios u horarios. ¿Qué necesitas?"
    : "I can check the Castellón weather, appointments, orders, services, or hours. What do you need?";
}

export function composeToolReply(results, lang, userText) {
  if (!results.length) return smallTalk(userText, lang);
  const sentences = results.map((result) => speakToolResult(result.name, result, lang, userText));
  if (sentences.length === 1) return sentences[0];
  const lead = lang === "es" ? "Te cuento varias cosas." : "Here are a few things.";
  return joinSentences([lead, ...sentences]);
}

export function forSpeech(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_#>`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
