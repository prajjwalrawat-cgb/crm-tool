import { richTextFromPlain } from './rich-text';
import type { QuoteTemplateBody } from './template-schema';

/**
 * Starter body for the classic (boxed GST proforma) layout, worded like a
 * Tally "Proforma Invoice": Consignee / Buyer boxes, "per" unit column,
 * 70/30 payment terms, delivery and refund terms, the e-invoice
 * declaration and an authorised-signatory block. Seller GSTIN, CIN, PAN and
 * bank details come from the quote's seller profile.
 */
export function classicProformaTemplateBody(): QuoteTemplateBody {
  return {
    theme: {
      layout: 'classic',
      fontFamily: 'noto-sans',
      primaryColor: '#111111',
      accentColor: '#7a2a0e',
      baseFontSize: 8,
      pageSize: 'A4',
      marginsMm: 10,
      logoSource: 'org',
    },
    sections: [
      {
        id: 'header',
        type: 'header',
        enabled: true,
        title: 'Header',
        settings: {
          logoPosition: 'left',
          logoHeightMm: 14,
          titleText: 'Proforma Invoice',
          showSellerFields: ['address', 'gstin'],
          metaFields: ['number', 'date'],
        },
      },
      {
        id: 'client',
        type: 'client',
        enabled: true,
        title: 'Client',
        settings: { showShipTo: true, billToLabel: 'Buyer (Bill to)', shipToLabel: 'Consignee (Ship to)' },
      },
      {
        id: 'payment_schedule',
        type: 'payment_schedule',
        enabled: true,
        title: 'Mode/Terms of Payment',
        settings: {
          repEditable: true,
          defaultMilestones: [
            { label: 'advance', percentBps: 7000 },
            { label: 'on dispatch', percentBps: 3000 },
          ],
        },
      },
      {
        id: 'terms',
        type: 'terms',
        enabled: true,
        title: 'Terms of Delivery',
        settings: {
          repEditable: true,
          defaultText: richTextFromPlain(
            '7-10 working days after PO/advance payment confirmation\n' +
              'No refund will be processed once payment is made\n' +
              'Mode of payment: Bank Transfer/UPI\n' +
              'If sample is rejected, no refund will be processed',
          ),
        },
      },
      {
        id: 'line_items',
        type: 'line_items',
        enabled: true,
        title: 'Items',
        settings: {
          groupByLabel: false,
          columns: [
            { key: 'sno', label: 'Sl No.', visible: true },
            { key: 'description', label: 'Description of Goods/Services', visible: true },
            { key: 'hsn_sac', label: 'HSN/SAC', visible: true },
            { key: 'quantity', label: 'Quantity', visible: true },
            { key: 'rate', label: 'Rate', visible: true },
            { key: 'unit', label: 'per', visible: true },
            { key: 'discount', label: 'Disc.', visible: false },
            { key: 'tax_rate', label: 'GST', visible: false },
            { key: 'amount', label: 'Amount', visible: true },
          ],
        },
      },
      {
        id: 'totals',
        type: 'totals',
        enabled: true,
        title: 'Totals',
        settings: {
          showSubtotal: true,
          discountDisplay: 'combined',
          showTaxBreakdown: true,
          showRoundOff: true,
          showAmountInWords: true,
        },
      },
      {
        id: 'declaration',
        type: 'text',
        enabled: true,
        title: 'Declaration',
        settings: {
          repEditable: false,
          defaultText: richTextFromPlain(
            'We hereby declare that our aggregate turnover in a financial year does not exceed the prescribed limit for ' +
              'mandatory issuance of E-Invoice or we are otherwise exempted from E-Invoicing requirement as per the ' +
              'provisions of GST Law, hence we are not required to issue E-Invoice under the GST law and provisions.',
          ),
        },
      },
      {
        id: 'signature',
        type: 'signature',
        enabled: true,
        title: 'Signature',
        settings: { signatoryName: '', signatoryTitle: '', showClientAcceptance: false },
      },
    ],
  };
}
