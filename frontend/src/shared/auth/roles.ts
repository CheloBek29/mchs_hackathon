export const CANONICAL_ROLES = [
  'ADMIN',
  'COMBAT_AREA_1',
  'COMBAT_AREA_2',
  'DISPATCHER',
  'HQ',
  'RTP',
  'TRAINING_LEAD',
] as const;

export type CanonicalRole = (typeof CANONICAL_ROLES)[number];

export const ROLE_LABELS_RU: Record<CanonicalRole, string> = {
  ADMIN: 'Админ',
  COMBAT_AREA_1: 'Боевой участок 1',
  COMBAT_AREA_2: 'Боевой участок 2',
  DISPATCHER: 'Диспетчер',
  HQ: 'Штаб',
  RTP: 'РТП',
  TRAINING_LEAD: 'Руководитель занятий',
};

const ROLE_ALIASES_TO_CANONICAL: Record<string, CanonicalRole> = {
  ADMIN: 'ADMIN',
  COMBAT_AREA_1: 'COMBAT_AREA_1',
  COMBAT_AREA_2: 'COMBAT_AREA_2',
  DISPATCHER: 'DISPATCHER',
  HQ: 'HQ',
  RTP: 'RTP',
  TRAINING_LEAD: 'TRAINING_LEAD',
  АДМИН: 'ADMIN',
  'БОЕВОЙ УЧАСТОК 1': 'COMBAT_AREA_1',
  БУ1: 'COMBAT_AREA_1',
  'БУ 1': 'COMBAT_AREA_1',
  'БОЕВОЙ УЧАСТОК 2': 'COMBAT_AREA_2',
  БУ2: 'COMBAT_AREA_2',
  'БУ 2': 'COMBAT_AREA_2',
  ДИСПЕТЧЕР: 'DISPATCHER',
  ШТАБ: 'HQ',
  РТП: 'RTP',
  'РУКОВОДИТЕЛЬ ЗАНЯТИЙ': 'TRAINING_LEAD',
  NSH: 'HQ',
  'НАЧАЛЬНИК ШТАБА': 'HQ',
  STAFF: 'COMBAT_AREA_1',
  ПОЖАРНЫЙ: 'COMBAT_AREA_1',
  СОТРУДНИК: 'COMBAT_AREA_1',
  FIREFIGHTER: 'COMBAT_AREA_1',
};

export const normalizeRoleName = (roleName: string): CanonicalRole | null => {
  const normalized = roleName.trim().toUpperCase();
  return ROLE_ALIASES_TO_CANONICAL[normalized] ?? null;
};

export const formatRoleLabel = (roleName: string): string => {
  const canonicalRole = normalizeRoleName(roleName);
  if (!canonicalRole) {
    return roleName;
  }
  return ROLE_LABELS_RU[canonicalRole];
};
