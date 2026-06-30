import 'server-only';

import { and, asc, eq, type SQL } from 'drizzle-orm';

import { db } from '@/db';
import {
  customFieldDefinitions,
  type CustomFieldDefinition,
  type CustomFieldEntity,
  type CustomFieldType,
} from '@/db/schema';

import type { CustomFieldDef } from './types';

/** Client-safe projection used by forms / detail pages. */
export function toClientDef(d: CustomFieldDefinition): CustomFieldDef {
  return {
    id: d.id,
    key: d.key,
    label: d.label,
    fieldType: d.fieldType,
    options: d.options ?? [],
    required: d.required,
  };
}

/** Active (non-archived) definitions for an entity, ordered for rendering. */
export async function listCustomFieldDefs(
  tenantId: string,
  entity: CustomFieldEntity,
): Promise<CustomFieldDef[]> {
  const conds: SQL[] = [
    eq(customFieldDefinitions.tenantId, tenantId),
    eq(customFieldDefinitions.entityType, entity),
    eq(customFieldDefinitions.archived, false),
  ];
  const rows = await db
    .select()
    .from(customFieldDefinitions)
    .where(and(...conds))
    .orderBy(
      asc(customFieldDefinitions.sortOrder),
      asc(customFieldDefinitions.createdAt),
    );
  return rows.map(toClientDef);
}

export type AdminCustomField = {
  id: string;
  key: string;
  label: string;
  fieldType: CustomFieldType;
  options: string[];
  required: boolean;
  sortOrder: number;
  archived: boolean;
};

/** All definitions (incl. archived) for the admin manager. */
export async function listAdminCustomFields(
  tenantId: string,
  entity: CustomFieldEntity,
): Promise<AdminCustomField[]> {
  const rows = await db
    .select()
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.tenantId, tenantId),
        eq(customFieldDefinitions.entityType, entity),
      ),
    )
    .orderBy(
      asc(customFieldDefinitions.archived),
      asc(customFieldDefinitions.sortOrder),
      asc(customFieldDefinitions.createdAt),
    );
  return rows.map((d) => ({
    id: d.id,
    key: d.key,
    label: d.label,
    fieldType: d.fieldType,
    options: d.options ?? [],
    required: d.required,
    sortOrder: d.sortOrder,
    archived: d.archived,
  }));
}
