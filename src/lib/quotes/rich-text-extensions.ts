/**
 * TipTap extensions for quote rich text. The schema they build only allows
 * what `richTextDocSchema` accepts (paragraph, heading 2|3, bullet/ordered
 * lists, hardBreak, placeholder; bold + italic), so `editor.getJSON()` is a
 * valid `RichTextDoc`. No React or DOM at import time: usable in self-tests.
 */
import { mergeAttributes, Node, type Extensions } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

/** Inline atom `{ type: 'placeholder', attrs: { key } }`, shown as a `{{key}}` chip. */
export const PlaceholderNode = Node.create({
  name: 'placeholder',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      key: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-placeholder') ?? '',
        renderHTML: (attrs) => ({ 'data-placeholder': attrs.key as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-placeholder]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        class:
          'mx-0.5 inline-block rounded bg-indigo-50 px-1 font-mono text-[11.5px] text-indigo-700 ring-1 ring-inset ring-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-500/30',
      }),
      `{{${node.attrs.key as string}}}`,
    ];
  },

  renderText({ node }) {
    return `{{${node.attrs.key as string}}}`;
  },
});

export function quoteRichTextExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      blockquote: false,
      code: false,
      codeBlock: false,
      horizontalRule: false,
      link: false,
      strike: false,
      underline: false,
      // A trailing empty paragraph would print as blank space in the PDF.
      trailingNode: false,
    }),
    PlaceholderNode,
  ];
}
