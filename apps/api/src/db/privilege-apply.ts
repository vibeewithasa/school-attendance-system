import { createHash } from 'node:crypto';

/**
 * Ejecucion controlada de una propuesta de privilegios (tools/db/privileges). Nunca se ejecuta SQL "extraido" de forma
 * informal: el archivo `.apply.sql` debe contener EXACTAMENTE los GRANT de la propuesta aprobada (se comparan sentencia por
 * sentencia) y nada mas que un preflight (bloques DO) y esos GRANT. Todo corre en una sola transaccion: preflight, GRANT y
 * verificador de privilegios efectivos; si algo falla, no queda ningun cambio parcial.
 */
export interface PrivilegeClient {
  query(sql: string): Promise<unknown>;
}

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Quita comentarios de linea y metacomandos de psql; deja solo SQL. */
function stripComments(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--') && !l.trim().startsWith('\\'))
    .join('\n');
}

/** Sentencias de nivel superior (separa por `;` fuera de bloques `$$ ... $$`). */
export function topLevelStatements(sql: string): string[] {
  const text = stripComments(sql);
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('$$', i)) {
      inDollar = !inDollar;
      current += '$$';
      i++;
      continue;
    }
    if (text[i] === ';' && !inDollar) {
      if (current.trim()) out.push(current.trim());
      current = '';
    } else current += text[i];
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

export interface ApplyProblems {
  problems: string[];
  grants: string[];
}

/** El `.apply.sql` solo puede tener bloques DO (preflight) y los GRANT de la propuesta, identicos y en el mismo orden. */
export function checkApplyMatchesProposal(applySql: string, proposalSql: string): ApplyProblems {
  const problems: string[] = [];
  const proposalGrants = topLevelStatements(proposalSql);
  if (proposalGrants.length === 0 || !proposalGrants.every((s) => /^grant\s/i.test(s)))
    problems.push('la propuesta debe contener unicamente sentencias GRANT');
  const statements = topLevelStatements(applySql);
  const grants = statements.filter((s) => !/^do\s+\$\$/i.test(s));
  const extra = grants.filter((s) => !/^grant\s/i.test(s));
  if (extra.length > 0)
    problems.push(`sentencias no permitidas en el archivo de ejecucion: ${extra.length}`);
  if (grants.map(normalize).join('|') !== proposalGrants.map(normalize).join('|'))
    problems.push(
      'los GRANT del archivo de ejecucion no son identicos a los de la propuesta aprobada',
    );
  for (const g of grants) {
    if (!/\sto\s+eta15_api$/i.test(g))
      problems.push(`GRANT que no se dirige solo a eta15_api: ${g.slice(0, 60)}`);
    if (
      /grant\s+option|\ball\b|\bdelete\b|\btruncate\b|\btrigger\b|\breferences\b|\bpublic\b|\bcreate\b/i.test(
        g,
      )
    )
      problems.push(`GRANT con privilegio no aprobado: ${g.slice(0, 60)}`);
  }
  if (!/^do\s+\$\$/i.test(statements[0] ?? ''))
    problems.push('el archivo debe empezar con el preflight (bloque DO)');
  // el preflight (DO) solo consulta: sin EXECUTE dinamico, REVOKE, DDL ni DML
  for (const block of statements.filter((x) => /^do\s+\$\$/i.test(x)))
    if (
      /\b(execute|revoke|drop|alter|create|insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i.test(
        block,
      )
    )
      problems.push('el preflight contiene sentencias que modifican la base');
  return { problems, grants };
}

export interface ApplyInput {
  applySql: string;
  verifySql: string;
  proposalSql: string;
  /** Si se indica, el SHA-256 del archivo de ejecucion debe coincidir (fija exactamente lo revisado). */
  expectedApplySha256?: string;
  /** false = ensayo: toda la transaccion se revierte (ROLLBACK) tras verificar. */
  commit: boolean;
}
export interface ApplyReport {
  applySha256: string;
  verifySha256: string;
  proposalSha256: string;
  grants: string[];
  committed: boolean;
}

export async function applyPrivileges(
  client: PrivilegeClient,
  input: ApplyInput,
): Promise<ApplyReport> {
  const check = checkApplyMatchesProposal(input.applySql, input.proposalSql);
  if (check.problems.length > 0)
    throw new Error(`archivo de ejecucion no valido: ${check.problems.join('; ')}`);
  const applySha256 = sha256(input.applySql);
  if (input.expectedApplySha256 && input.expectedApplySha256.toLowerCase() !== applySha256)
    throw new Error('el SHA-256 del archivo de ejecucion no coincide con el revisado');
  await client.query('BEGIN');
  try {
    await client.query(input.applySql);
    await client.query(input.verifySql);
    await client.query(input.commit ? 'COMMIT' : 'ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  return {
    applySha256,
    verifySha256: sha256(input.verifySql),
    proposalSha256: sha256(input.proposalSql),
    grants: check.grants,
    committed: input.commit,
  };
}
