declare module "pdf-parse" {
  interface PdfPageTextItem {
    str?: string;
    transform?: number[];
  }

  interface PdfPageData {
    getTextContent: () => Promise<{ items: PdfPageTextItem[] }>;
  }

  interface PdfOptions {
    pagerender?: (pageData: PdfPageData) => Promise<string>;
  }

  interface PdfData {
    text: string;
    numpages: number;
  }

  const parsePdf: (data: Buffer, options?: PdfOptions) => Promise<PdfData>;
  export default parsePdf;
}
