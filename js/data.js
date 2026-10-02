// Every Supabase read and write the app makes. Amounts come back as
// `amount` (cents), whatever the column is called.
import { supabase } from './supabase.js';

async function run(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

const rpc = (name, args) => run(supabase.rpc(name, args));

// ---------- Household ----------

// The signed-in user's household (see household_info() in 001_schema.sql),
// or null if they aren't in one yet.
export const loadHouseholdInfo = () => rpc('household_info');

// { kind: 'join' | 'household', household_name } for a usable code, else null.
export const checkInvite = code => rpc('check_invite', { p_code: code });

export const createHousehold = (name, displayName, code) =>
  rpc('create_household', { p_name: name, p_display_name: displayName, p_code: code || null });

export const joinHousehold = (code, displayName) =>
  rpc('join_household', { p_code: code, p_display_name: displayName });

// { code, expires_at }
export const createJoinCode = () => rpc('create_join_code');
export const createHouseholdCode = () => rpc('create_household_code');

// Any of { name, roundWhole, startingCents, setupDone }.
export const updateHousehold = ({ name = null, roundWhole = null, startingCents = null, setupDone = null }) =>
  rpc('update_household', {
    p_name: name, p_round_whole: roundWhole, p_starting_cents: startingCents, p_setup_done: setupDone,
  });

export const updateMyName = name => rpc('update_my_name', { p_display_name: name });

// periodId + nextStart: the current period now ends at nextStart, and later
// periods are made again from the new schedule.
export const setPaySchedule = (schedule, periodId = null, nextStart = null) =>
  rpc('set_pay_schedule', { p_schedule: schedule, p_period_id: periodId, p_next_start: nextStart });

export const deleteMyAccount = () => rpc('delete_my_account');

// ---------- Periods ----------

const PERIOD_COLUMNS = 'id, start_date, next_start, starts_on, starting:starting_cents';

// Creates the period [start, next) from the current defaults the first time
// it's opened. startsOn only counts for the household's very first period.
export async function ensurePeriod(startISO, nextISO, startsOnISO = null) {
  const row = await rpc('ensure_period', { p_start: startISO, p_next: nextISO, p_starts_on: startsOnISO });
  return { ...row, starting: row.starting_cents };
}

// Every period that exists, oldest first.
export const loadPayPeriods = () =>
  run(supabase.from('pay_periods').select(PERIOD_COLUMNS).order('start_date'));

// Confirms the day a period actually began (payday).
export const startPeriod = (periodId, startsOnISO) =>
  rpc('start_period', { p_period_id: periodId, p_starts_on: startsOnISO });

// Extra carried in from earlier periods.
export async function loadCarryIn(periodId) {
  const rows = await run(supabase.from('period_extra_carry').select('carry_in').eq('period_id', periodId));
  return rows.length ? Number(rows[0].carry_in) : 0;
}

export const loadAllCarryIn = () => run(supabase.from('period_extra_carry').select('period_id, carry_in'));

export const setCategoryEmptied = (periodId, categoryIds, emptied) =>
  run(supabase.from('period_categories').update({ emptied }).eq('period_id', periodId).in('category_id', categoryIds));

// ---------- Categories, bills, cards ----------

export const loadCategories = () =>
  run(supabase.from('categories')
    .select('id, name, color, amount:default_cents, sort_order, is_active, is_remainder')
    .order('sort_order').order('id'));

export const loadPeriodCategories = periodId =>
  run(supabase.from('period_categories').select('category_id, amount:amount_cents, emptied').eq('period_id', periodId));

export const loadFixedCosts = periodId =>
  run(supabase.from('fixed_costs')
    .select('id, name, amount:amount_cents, is_paid, template_id, due_date')
    .eq('period_id', periodId)
    .order('due_date', { nullsFirst: false }).order('name'));

// Recurring bills (the defaults every new period gets).
export const loadBillTemplates = () =>
  run(supabase.from('bill_templates')
    .select('id, name, amount:default_cents, due_day')
    .eq('is_active', true)
    .order('due_day').order('name'));

export const loadCards = () =>
  run(supabase.from('cards').select('id, name, kind, badge, color, sort_order, is_active').order('sort_order').order('id'));

export function saveCard({ id, name, kind, badge, color, sort_order }) {
  const fields = { name, kind, badge, color };
  if (sort_order != null) fields.sort_order = sort_order;
  return id
    ? run(supabase.from('cards').update(fields).eq('id', id))
    : run(supabase.from('cards').insert([fields]));
}

export const setCardActive = (id, isActive) =>
  run(supabase.from('cards').update({ is_active: isActive }).eq('id', id));

// Unticking a bill and ticking it.
export const setFixedPaid = (id, isPaid) =>
  run(supabase.from('fixed_costs').update({ is_paid: isPaid }).eq('id', id));

export const saveSettings = args => rpc('save_settings', args);

// ---------- Expenses ----------

const EXPENSE_COLUMNS = 'id, period_id, category_id, card_id, merchant, amount:amount_cents, transaction_type, created_at, created_by, from_savings';

export const loadExpenses = periodId =>
  run(supabase.from('expenses').select(EXPENSE_COLUMNS).eq('period_id', periodId).order('created_at'));

// Fields use the app's names (amount in cents); see toRow.
const toRow = ({ amount, ...rest }) => (amount == null ? rest : { ...rest, amount_cents: amount });

export const addExpense = fields => run(supabase.from('expenses').insert([toRow(fields)]));

export const updateExpense = (id, fields) => run(supabase.from('expenses').update(toRow(fields)).eq('id', id));

// Supabase reports success even when row-level security silently blocks a
// delete, so ask for the deleted row back and check it actually went.
export async function deleteExpense(id) {
  const deleted = await run(supabase.from('expenses').delete().eq('id', id).select('id'));
  if (!deleted.length) throw new Error('The database didn\'t delete it.');
}

// Pages through results because Supabase caps each response at 1000 rows.
async function selectAll(table, columns, filter = q => q) {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const page = await run(filter(supabase.from(table).select(columns)).order('id').range(from, from + pageSize - 1));
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

// ---------- Insights ----------

export const loadExpensesFor = periodIds =>
  periodIds.length
    ? selectAll('expenses', 'id, period_id, category_id, merchant, amount:amount_cents, transaction_type, created_at',
        q => q.in('period_id', periodIds).eq('from_savings', false)) // savings purchases never count
    : Promise.resolve([]);

export const loadFixedCostsFor = periodIds =>
  periodIds.length
    ? selectAll('fixed_costs', 'id, period_id, amount:amount_cents', q => q.in('period_id', periodIds))
    : Promise.resolve([]);

export const loadPeriodCategoriesFor = periodIds =>
  periodIds.length
    ? run(supabase.from('period_categories').select('period_id, category_id, amount:amount_cents, emptied').in('period_id', periodIds))
    : Promise.resolve([]);

// ---------- Store suggestions ----------

// Every store name ever entered, for suggestions in the expense sheet.
export const loadMerchantHistory = () => selectAll('expenses', 'id, merchant, category_id, created_at');

export async function loadHiddenMerchants() {
  const rows = await run(supabase.from('hidden_merchants').select('merchant_key'));
  return rows.map(r => r.merchant_key);
}

export const hideMerchant = key =>
  run(supabase.from('hidden_merchants')
    .upsert([{ merchant_key: key }], { onConflict: 'household_id,merchant_key', ignoreDuplicates: true }));

export const unhideMerchant = key => run(supabase.from('hidden_merchants').delete().eq('merchant_key', key));
