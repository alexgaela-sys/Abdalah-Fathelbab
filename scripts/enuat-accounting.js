// Accounting placeholder for HR automation
export function computePayrollTotal(employees) {
  return employees.reduce((sum, emp) => sum + (emp.pay || 0), 0);
}

export function averageSalary(employees) {
  if (!employees.length) return 0;
  return computePayrollTotal(employees) / employees.length;
}

export function maxSalary(employees) {
  if (!employees.length) return 0;
  return Math.max(...employees.map(e => e.pay || 0));
}

export function minSalary(employees) {
  if (!employees.length) return Infinity;
  return Math.min(...employees.map(e => e.pay || 0));
}

export function totalTaxContribution(employees, rate) {
  return computePayrollTotal(employees) * rate;
}
