'use client';

import { useState } from 'react';

import { KNOWN_CURRENCIES } from '@/lib/deals/currency';
import { cn } from '@/lib/utils';

/**
 * Amount section of the deal form. When the workspace enables per-unit pricing
 * it shows Per Unit Price + Quantity and computes a read-only Amount
 * (= price x qty); otherwise a normal Amount input. Native `name=` inputs
 * submit straight through the form's FormData; the server re-derives Amount.
 */
const labelCls = 'text-xs font-medium text-slate-700';
const inputCls =
  'rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm shadow-sm transition placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20';

export function DealAmountFields({
  unitPricingEnabled,
  defaultCurrency,
  defaultAmount,
  defaultUnitPrice,
  defaultQuantity,
  defaultMarginPct,
  errors,
}: {
  unitPricingEnabled: boolean;
  defaultCurrency: string;
  defaultAmount?: string;
  defaultUnitPrice?: string;
  defaultQuantity?: string;
  defaultMarginPct?: string;
  errors: Record<string, string[]>;
}) {
  const [unitPrice, setUnitPrice] = useState(defaultUnitPrice ?? '');
  const [quantity, setQuantity] = useState(defaultQuantity ?? '');
  const computed = (Number(unitPrice) || 0) * (Number(quantity) || 0);

  const currency = (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="currency" className={labelCls}>Currency</label>
      <select id="currency" name="currency" defaultValue={defaultCurrency} className={inputCls}>
        {KNOWN_CURRENCIES.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
    </div>
  );

  // Optional gross margin percentage — shown in both pricing modes.
  const margin = (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="marginPct" className={labelCls}>
        Margin % <span className="font-normal text-slate-400">(optional)</span>
      </label>
      <div className="relative">
        <input
          id="marginPct"
          name="marginPct"
          type="number"
          step="0.01"
          min="0"
          max="100"
          defaultValue={defaultMarginPct ?? ''}
          placeholder="0"
          className={cn(inputCls, 'w-full pr-7', errors.marginPct?.length && 'border-red-300')}
        />
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-slate-400">
          %
        </span>
      </div>
      {errors.marginPct?.length ? <p className="text-xs text-red-600">{errors.marginPct.join(' ')}</p> : null}
    </div>
  );

  if (!unitPricingEnabled) {
    return (
      <>
        <div className="grid grid-cols-[1fr_88px] gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="amount" className={labelCls}>Amount</label>
            <input
              id="amount"
              name="amount"
              type="number"
              step="0.01"
              min="0"
              defaultValue={defaultAmount ?? '0'}
              placeholder="0.00"
              className={cn(inputCls, errors.amount?.length && 'border-red-300')}
            />
            {errors.amount?.length ? <p className="text-xs text-red-600">{errors.amount.join(' ')}</p> : null}
          </div>
          {currency}
        </div>
        <div className="grid grid-cols-2 gap-3">
          {margin}
          <div />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="unitPrice" className={labelCls}>Per Unit Price</label>
          <input
            id="unitPrice"
            name="unitPrice"
            type="number"
            step="0.01"
            min="0"
            value={unitPrice}
            onChange={(e) => setUnitPrice(e.target.value)}
            placeholder="0.00"
            className={cn(inputCls, errors.unitPrice?.length && 'border-red-300')}
          />
          {errors.unitPrice?.length ? <p className="text-xs text-red-600">{errors.unitPrice.join(' ')}</p> : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="quantity" className={labelCls}>Quantity (Qty)</label>
          <input
            id="quantity"
            name="quantity"
            type="number"
            step="1"
            min="0"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="0"
            className={cn(inputCls, errors.quantity?.length && 'border-red-300')}
          />
          {errors.quantity?.length ? <p className="text-xs text-red-600">{errors.quantity.join(' ')}</p> : null}
        </div>
      </div>
      <div className="grid grid-cols-[1fr_88px] gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="amount" className={labelCls}>
            Amount <span className="font-normal text-slate-400">(auto)</span>
          </label>
          <input
            id="amount"
            name="amount"
            type="number"
            value={computed}
            readOnly
            aria-readonly
            className={cn(inputCls, 'cursor-not-allowed bg-slate-50 text-slate-600')}
          />
        </div>
        {currency}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {margin}
        <div />
      </div>
    </>
  );
}
