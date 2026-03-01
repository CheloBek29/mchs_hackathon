/**
 * Справочник типов ручных и лафетных стволов.
 * Диапазоны расхода соответствуют physics_config.py::NOZZLE_TYPES.
 */
export type NozzleTypeName = 'RS50' | 'RS70' | 'DELTA' | 'GPS600' | 'DEFAULT';

export interface NozzleTypeSpec {
  label: string;
  shortLabel: string;
  minLs: number;
  maxLs: number;
  defaultLs: number;
  efficiency: number;
  description: string;
}

export const NOZZLE_TYPE_SPECS: Record<NozzleTypeName, NozzleTypeSpec> = {
  RS50: {
    label: 'РС-50',
    shortLabel: 'РС-50',
    minLs: 1.5,
    maxLs: 4.0,
    defaultLs: 2.8,
    efficiency: 1.0,
    description: 'Ручной ствол 50 мм',
  },
  RS70: {
    label: 'РС-70',
    shortLabel: 'РС-70',
    minLs: 3.0,
    maxLs: 7.5,
    defaultLs: 5.5,
    efficiency: 1.1,
    description: 'Ручной ствол 70 мм, увеличенный охват',
  },
  DELTA: {
    label: 'DELTA (лафетный)',
    shortLabel: 'DELTA',
    minLs: 5.0,
    maxLs: 10.0,
    defaultLs: 7.0,
    efficiency: 1.15,
    description: 'Лафетный ствол, большой расход',
  },
  GPS600: {
    label: 'ГПС-600 (пена)',
    shortLabel: 'ГПС-600',
    minLs: 2.5,
    maxLs: 6.0,
    defaultLs: 4.0,
    efficiency: 1.05,
    description: 'Генератор пены средней кратности',
  },
  DEFAULT: {
    label: 'Без типа',
    shortLabel: 'Ручной',
    minLs: 1.0,
    maxLs: 12.0,
    defaultLs: 3.5,
    efficiency: 1.0,
    description: 'Тип ствола не указан',
  },
};

export const NOZZLE_TYPE_OPTIONS: Array<{ value: NozzleTypeName; label: string }> =
  Object.entries(NOZZLE_TYPE_SPECS).map(([value, spec]) => ({
    value: value as NozzleTypeName,
    label: spec.label,
  }));
