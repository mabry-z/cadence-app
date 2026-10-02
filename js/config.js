export const SUPABASE_URL = 'https://mjswvkyzlibzzjjzijir.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_lXifWlC2qXbcZdvzwjF_Zw_jV3kwlco';

// Handed out in order to newly added categories.
export const CATEGORY_COLORS = [
  '#7CA3F2', '#E9A6D0', '#F2A65C', '#5BC7A6',
  '#B69CF2', '#F2D56B', '#6BD0E0', '#E07A7A',
];

// Card badge colours to pick from (white text sits on all of them).
export const CARD_COLORS = [
  '#1E3A6B', '#0E8C86', '#9A6A12', '#8E3B5B', '#5B3FA8', '#2F7D4A', '#B4462F', '#4B535C',
];

export const CARD_KINDS = [
  { value: 'debit', label: 'Debit' },
  { value: 'credit', label: 'Credit' },
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
];

// One-tap cards in setup and Settings.
export const CARD_PRESETS = [
  { name: 'Debit card', kind: 'debit', badge: 'DB', color: '#1E3A6B' },
  { name: 'Credit card', kind: 'credit', badge: 'CC', color: '#0E8C86' },
  { name: 'Cash', kind: 'cash', badge: '$', color: '#4B535C' },
  { name: 'Venmo', kind: 'other', badge: 'V', color: '#5B3FA8' },
];

// Suggested in setup, so nobody starts from a blank page.
export const CATEGORY_SUGGESTIONS = ['Groceries', 'Gas', 'Eating out', 'Household', 'Kids', 'Pets', 'Fun money', 'Gifts'];
