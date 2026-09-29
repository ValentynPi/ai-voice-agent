import { CUSTOMERS, HOURS, ORDERS, SERVICES, STAFF } from "./demo-data.js";

function norm(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

function orderId(value) {
  const digits = String(value ?? "").toUpperCase().replace(/[^0-9]/g, "");
  if (!digits) return "";
  return `ORD-${digits}`;
}

export function listOrders({ status } = {}) {
  const wanted = norm(status);
  const orders = wanted ? ORDERS.filter((order) => order.status === wanted) : ORDERS;
  return { count: orders.length, orders };
}

export function getOrder({ id, customer } = {}) {
  if (id) {
    const wanted = orderId(id);
    const order = ORDERS.find((item) => item.id === wanted);
    return order
      ? { found: true, order }
      : { found: false, knownIds: ORDERS.map((item) => item.id) };
  }
  if (customer) {
    const wanted = norm(customer);
    const order = ORDERS.find((item) => norm(item.customer).includes(wanted) || wanted.includes(norm(item.customer).split(" ")[0]));
    return order
      ? { found: true, order }
      : { found: false, knownIds: ORDERS.map((item) => item.id) };
  }
  return { found: false, hint: "Provide an order id or customer name.", knownIds: ORDERS.map((item) => item.id) };
}

export function lookupCustomer({ name } = {}) {
  const wanted = norm(name);
  if (!wanted) {
    return { found: false, customers: CUSTOMERS.map((customer) => customer.name) };
  }
  const customer = CUSTOMERS.find((item) => {
    const full = norm(item.name);
    return full.includes(wanted) || wanted.includes(full) || full.split(" ").some((part) => part === wanted);
  });
  if (!customer) {
    return { found: false, customers: CUSTOMERS.map((item) => item.name) };
  }
  return { found: true, customer };
}

export function listAppointments() {
  const appointments = CUSTOMERS.filter((customer) => customer.nextAppointment).map((customer) => ({
    customer: customer.name,
    customerId: customer.id,
    ...customer.nextAppointment,
  }));
  return { count: appointments.length, appointments };
}

export function queryServices({ q } = {}) {
  const wanted = norm(q);
  const services = wanted
    ? SERVICES.filter((service) => norm(service.name).includes(wanted))
    : SERVICES;
  return { count: services.length, services };
}

export function queryStaff() {
  return { count: STAFF.length, staff: STAFF };
}

export function queryHours() {
  return HOURS;
}
