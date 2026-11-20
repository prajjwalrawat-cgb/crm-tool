import { View } from '@react-pdf/renderer';

/** Forces the next section onto a new page. */
export function PageBreakSectionPdf() {
  return <View break />;
}
