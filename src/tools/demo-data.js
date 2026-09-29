export const SALON = {
  name: "Maison Sol",
  city: "Castellón de la Plana",
  address: "Carrer Major 8, demo suite, Castellón de la Plana",
  timezone: "Europe/Madrid",
};

export const HOURS = {
  timezone: SALON.timezone,
  address: SALON.address,
  note: "Fictional demo salon. Closed Sunday and Monday.",
  days: [
    { day: "Monday", open: null, close: null },
    { day: "Tuesday", open: "10:00", close: "20:00" },
    { day: "Wednesday", open: "10:00", close: "20:00" },
    { day: "Thursday", open: "10:00", close: "20:00" },
    { day: "Friday", open: "10:00", close: "20:00" },
    { day: "Saturday", open: "10:00", close: "20:00" },
    { day: "Sunday", open: null, close: null },
  ],
};

export const SERVICES = [
  { id: "cut-blowdry", name: "Cut and blow-dry", minutes: 60, priceEur: 45 },
  { id: "mens-cut", name: "Men's cut", minutes: 30, priceEur: 28 },
  { id: "balayage", name: "Balayage", minutes: 180, priceEur: 120 },
  { id: "balayage-cut", name: "Balayage and cut", minutes: 210, priceEur: 145 },
  { id: "keratin", name: "Keratin treatment", minutes: 150, priceEur: 180 },
  { id: "color-correction", name: "Color correction", minutes: 240, priceEur: 210 },
];

export const STAFF = [
  { id: "marta", name: "Marta Soler", role: "Color specialist", days: "Tue–Sat" },
  { id: "joan", name: "Joan Beltran", role: "Treatments", days: "Wed–Sat" },
  { id: "nuria", name: "Núria Palau", role: "Cuts", days: "Tue–Fri" },
];

export const CUSTOMERS = [
  {
    id: "CRM-201",
    name: "Ana Ruiz",
    phone: "+34 600 111 222",
    email: "ana.ruiz@example.test",
    loyalty: "Gold",
    notes: "Prefers lowlights. Sensitive scalp.",
    lastVisit: "2026-08-12",
    nextAppointment: {
      date: "2026-09-30",
      time: "11:00",
      service: "Balayage and cut",
      stylist: "Marta Soler",
    },
  },
  {
    id: "CRM-214",
    name: "Lucía Ferrer",
    phone: "+34 600 333 444",
    email: "lucia.ferrer@example.test",
    loyalty: "Silver",
    notes: "Allergic to ammonia. Use ammonia-free color only.",
    lastVisit: "2026-07-02",
    nextAppointment: {
      date: "2026-10-02",
      time: "16:30",
      service: "Keratin treatment",
      stylist: "Joan Beltran",
    },
  },
  {
    id: "CRM-188",
    name: "Elena Vidal",
    phone: "+34 600 555 666",
    email: "elena.vidal@example.test",
    loyalty: "VIP",
    notes: "Prefers Marta. Usually books a gloss between colors.",
    lastVisit: "2026-09-28",
    nextAppointment: null,
  },
];

export const ORDERS = [
  {
    id: "ORD-1042",
    customer: "Ana Ruiz",
    service: "Balayage and cut",
    stylist: "Marta Soler",
    status: "confirmed",
    date: "2026-09-30",
    time: "11:00",
    totalEur: 145,
  },
  {
    id: "ORD-1048",
    customer: "Lucía Ferrer",
    service: "Keratin treatment",
    stylist: "Joan Beltran",
    status: "pending",
    date: "2026-10-02",
    time: "16:30",
    totalEur: 180,
  },
  {
    id: "ORD-1033",
    customer: "Elena Vidal",
    service: "Color correction",
    stylist: "Marta Soler",
    status: "completed",
    date: "2026-09-28",
    time: "10:00",
    totalEur: 210,
  },
];

export const CUSTOMER_KEYS = [
  { name: "Ana Ruiz", keys: ["ana ruiz", "ana"] },
  { name: "Lucía Ferrer", keys: ["lucia ferrer", "lucía ferrer", "lucia", "lucía"] },
  { name: "Elena Vidal", keys: ["elena vidal", "elena"] },
];

export function getCatalog() {
  return {
    salon: SALON,
    hours: HOURS,
    services: SERVICES,
    staff: STAFF,
    customers: CUSTOMERS,
    orders: ORDERS,
  };
}
