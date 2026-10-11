import type { FunctionId } from './contracts';

// Visual grouping only. Department IDs do not replace domain AreaId values or
// confer access to the functions represented by a department.
export type DepartmentId = 'sales' | 'marketing' | 'operations' | 'suppliers' | 'finance' | 'quality' | 'talent';
export type OfficeDepartment = {
  id: DepartmentId;
  name: string;
  color: string;
  functionIds: readonly FunctionId[];
  primaryFunctionId: FunctionId;
};

export const DEPARTMENTS: readonly OfficeDepartment[] = [
  { id: 'sales', name: 'Ventas', color: '#fd5976', functionIds: ['sales', 'proposals'], primaryFunctionId: 'sales' },
  { id: 'marketing', name: 'Marketing', color: '#64b7fc', functionIds: ['marketing'], primaryFunctionId: 'marketing' },
  { id: 'operations', name: 'Operaciones', color: '#fdb409', functionIds: ['coordination', 'logistics'], primaryFunctionId: 'coordination' },
  { id: 'suppliers', name: 'Proveedores', color: '#4fba7c', functionIds: ['suppliers'], primaryFunctionId: 'suppliers' },
  { id: 'finance', name: 'Finanzas', color: '#9260f8', functionIds: ['finance'], primaryFunctionId: 'finance' },
  { id: 'quality', name: 'Calidad', color: '#48a9b9', functionIds: ['quality'], primaryFunctionId: 'quality' },
  { id: 'talent', name: 'Talento', color: '#c17fc7', functionIds: ['talent'], primaryFunctionId: 'talent' },
];

export const departments = DEPARTMENTS;
export function departmentById(id: DepartmentId): OfficeDepartment {
  return DEPARTMENTS.find(department => department.id === id)!;
}
export function departmentForFunction(functionId: FunctionId): OfficeDepartment {
  return DEPARTMENTS.find(department => department.functionIds.includes(functionId))!;
}

// Presentation of the human role requested for the demo, not authenticated
// identity or evidence of assignment, presence, capacity, or sale closure.
export const HUMAN_OPERATOR = {
  name: 'Ricardo',
  role: 'Operador humano',
  functionIds: ['sales', 'coordination', 'logistics'] as readonly FunctionId[],
};

export type OfficeAssistantPresentation = {
  functionId: FunctionId;
  name: string;
  role: 'Asistente virtual';
};

export const ASSISTANTS: readonly OfficeAssistantPresentation[] = [
  { functionId: 'sales', name: 'Asistente de Ventas', role: 'Asistente virtual' },
  { functionId: 'proposals', name: 'Asistente de Propuestas', role: 'Asistente virtual' },
  { functionId: 'marketing', name: 'Asistente de Marketing', role: 'Asistente virtual' },
  { functionId: 'coordination', name: 'Asistente de Coordinación', role: 'Asistente virtual' },
  { functionId: 'logistics', name: 'Asistente de Logística', role: 'Asistente virtual' },
  { functionId: 'suppliers', name: 'Asistente de Proveedores', role: 'Asistente virtual' },
  { functionId: 'finance', name: 'Asistente de Finanzas', role: 'Asistente virtual' },
  { functionId: 'quality', name: 'Asistente de Calidad', role: 'Asistente virtual' },
  { functionId: 'talent', name: 'Asistente de Talento', role: 'Asistente virtual' },
];

export function assistantForFunction(functionId: FunctionId): OfficeAssistantPresentation {
  return ASSISTANTS.find(assistant => assistant.functionId === functionId)!;
}
