import { richTextFromPlain } from "./rich-text";
import type { QuoteTemplateBody } from "./template-schema";

export function defaultTemplateBody(): QuoteTemplateBody {
  return {
    theme: {
      fontFamily: "noto-sans",
      primaryColor: "#1f2937",
      accentColor: "#2563eb",
      baseFontSize: 10,
      pageSize: "A4",
      marginsMm: 20,
      logoSource: "org",
    },
    sections: [
      {
        id: "header",
        type: "header",
        enabled: true,
        title: "Header",
        settings: {
          logoPosition: "left",
          logoHeightMm: 18,
          titleText: "Quotation",
          showSellerFields: ["gstin", "address", "email", "phone"],
          metaFields: ["number", "date", "valid_until", "rep"],
        },
      },
      {
        id: "client",
        type: "client",
        enabled: true,
        title: "Client",
        settings: {
          showShipTo: false,
          billToLabel: "Bill to",
          shipToLabel: "Ship to",
        },
      },
      {
        id: "intro",
        type: "text",
        enabled: true,
        title: "Introduction",
        settings: {
          repEditable: true,
          defaultText: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Dear " },
                  { type: "placeholder", attrs: { key: "client.contact" } },
                  { type: "text", text: ", thank you for your interest in " },
                  { type: "placeholder", attrs: { key: "seller.name" } },
                  { type: "text", text: ". Please find our quotation below." },
                ],
              },
            ],
          },
        },
      },
      {
        id: "line_items",
        type: "line_items",
        enabled: true,
        title: "Items",
        settings: {
          groupByLabel: false,
          columns: [
            { key: "sno", label: "#", visible: true },
            { key: "description", label: "Description", visible: true },
            { key: "hsn_sac", label: "HSN/SAC", visible: true },
            { key: "unit", label: "Unit", visible: false },
            { key: "quantity", label: "Qty", visible: true },
            { key: "rate", label: "Rate", visible: true },
            { key: "discount", label: "Disc.", visible: false },
            { key: "tax_rate", label: "GST", visible: true },
            { key: "amount", label: "Amount", visible: true },
          ],
        },
      },
      {
        id: "totals",
        type: "totals",
        enabled: true,
        title: "Totals",
        settings: {
          showSubtotal: true,
          discountDisplay: "combined",
          showTaxBreakdown: true,
          showRoundOff: false,
          showAmountInWords: true,
        },
      },
      {
        id: "payment_schedule",
        type: "payment_schedule",
        enabled: true,
        title: "Payment schedule",
        settings: {
          repEditable: true,
          defaultMilestones: [
            { label: "Advance with order", percentBps: 5000 },
            { label: "On delivery", percentBps: 5000 },
          ],
        },
      },
      {
        id: "terms",
        type: "terms",
        enabled: true,
        title: "Terms and conditions",
        settings: {
          repEditable: true,
          defaultText: richTextFromPlain(
            "Prices are in INR and exclusive of taxes unless stated.\nThis quotation is valid until the date shown above.",
          ),
        },
      },
      {
        id: "signature",
        type: "signature",
        enabled: true,
        title: "Signature",
        settings: {
          signatoryName: "",
          signatoryTitle: "",
          showClientAcceptance: true,
        },
      },
    ],
  };
}
