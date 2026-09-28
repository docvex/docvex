// A SAMPLE WORD DOCUMENT holding every highlight the DocVex file viewer draws,
// so each can be seen (and clicked, and hovered for its pill) on a real file:
// acts and codes (legislatie.just.ro), CAEN codes — inline and as a trade
// register list — (insse.ro), CUIs (anaf.ro), internal cross-references whose
// clauses exist, and empty fields in every shape the viewer reads as one
// (a DocVex `[[token]]`, a run of underscores, a dotted run, Word's own
// underlined gap). Added from the Files tab's toolbar ("Highlights sample").
//
// Every line was checked against lib/lawRefs (findLawRefs / findCuiRefs) so
// each citation is found whole and on its own — two acts or two
// cross-references in one sentence can merge into one mark.

export const HIGHLIGHTS_SAMPLE_NAME = 'DocVex - highlights sample.docx';

// A paragraph is a list of pieces: a string, or { text, bold, underline }.
const BODY = [
  { title: 'CONTRACT DE PRESTĂRI SERVICII' },
  { note: 'A DocVex sample. It shows every highlight the file viewer draws — hover one for what it is, click it to open it. The eye quick action (Highlights) shows and hides them all, empty fields included.' },

  { head: 'Art. 1. PĂRȚILE CONTRACTANTE' },
  { p: ['1.1. ', { text: '[[prestator.legalName]]', bold: true }, ', cu sediul în [[prestator.address]], CUI 14399840, reprezentată prin ________________, în calitate de administrator, denumită în continuare Prestatorul.'] },
  { p: ['1.2. SC BETA CONSTRUCT SRL, cu sediul în București, cod de înregistrare fiscală RO 2408422, denumită în continuare Beneficiarul.'] },

  { head: 'Art. 2. OBIECTUL CONTRACTULUI' },
  { p: ['2.1. Obiectul principal de activitate al Prestatorului este cod CAEN 6201, iar activitățile secundare sunt CAEN 6202, 6209 și 4741.'] },
  { p: ['2.2. Activitățile înscrise în certificatul constatator, potrivit CAEN Rev. 3, sunt:'] },
  { p: ['6210 - Activități de realizare a soft-ului la comandă (software orientat client)'] },
  { p: ['6220 - Activități de consultanță în tehnologia informației'] },

  { head: 'Art. 3. TEMEIUL JURIDIC' },
  { p: ['3.1. Părțile sunt organizate potrivit Legii nr. 31/1990 privind societățile, republicată, cu modificările și completările ulterioare.'] },
  { p: ['3.2. Prezentul contract se completează cu dispozițiile art. 1.166 alin. (1) din Legea nr. 287/2009 privind Codul civil.'] },
  { p: ['3.3. Transporturile se efectuează cu respectarea O.U.G. nr. 195/2002 privind circulația pe drumurile publice.'] },
  { p: ['3.4. Datele cu caracter personal se prelucrează conform Regulamentului (UE) 2016/679.'] },
  { p: ['3.5. Litigiile se soluționează potrivit Codului de procedură civilă.'] },
  { p: ['3.6. Raporturile de muncă ale personalului sunt guvernate de Codul muncii.'] },

  { head: 'Art. 4. OBLIGAȚIILE PĂRȚILOR' },
  { p: ['4.1. Prestatorul execută serviciile la termenele convenite.'] },
  { p: ['4.2. Beneficiarul plătește prețul de ........ lei în termen de 30 de zile.'] },
  { p: ['4.3. Prestatorul notifică în scris orice întârziere, în cel mult 3 zile lucrătoare.'] },

  { head: 'Art. 5. TRIMITERI ÎN CONTRACT' },
  { p: ['5.1. Notificările se transmit la adresa indicată la pct. 6.1. lit. d).'] },
  { p: ['5.2. O întârziere se comunică în forma prevăzută de clauza 4.3.'] },
  { p: ['5.3. Contractul încetează în condițiile prevăzute la art. 7.'] },

  { head: 'Art. 6. COMUNICĂRI' },
  { p: ['6.1. Datele de contact ale părților sunt următoarele:'] },
  { p: ['a) telefon: [[prestator.phone]];'] },
  { p: ['b) adresa poștală: sediul social;'] },
  { p: ['c) persoana de contact: ________________;'] },
  { p: ['d) adresa de e-mail pentru notificări: [[prestator.email]].'] },

  { head: 'Art. 7. ÎNCETAREA CONTRACTULUI' },
  { p: ['7.1. Contractul încetează prin acordul părților sau prin reziliere.'] },
  // Word's OWN blank: a gap drawn as underlined spaces.
  { p: ['Încheiat astăzi, ', { text: ' '.repeat(22), underline: true }, ', în două exemplare originale.'] },
];

/** The sample as a .docx Blob (the `docx` library, lazy-imported). */
export async function buildHighlightsSampleDocx() {
  const { Document, Packer, Paragraph, TextRun, AlignmentType } = await import('docx');
  const run = (piece) => (typeof piece === 'string'
    ? new TextRun({ text: piece })
    : new TextRun({ text: piece.text, bold: !!piece.bold, underline: piece.underline ? {} : undefined }));
  const children = BODY.map((b) => {
    if (b.title) return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text: b.title, bold: true, size: 28 })] });
    if (b.note) return new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: b.note, italics: true, color: '6B7280', size: 20 })] });
    if (b.head) return new Paragraph({ spacing: { before: 240, after: 120 }, children: [new TextRun({ text: b.head, bold: true })] });
    return new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 120 }, children: b.p.map(run) });
  });
  const doc = new Document({
    styles: { default: { document: { run: { font: 'Times New Roman', size: 24 } } } },
    sections: [{ children }],
  });
  return Packer.toBlob(doc);
}

// The text of the sample, one paragraph a line (for tests).
export const highlightsSampleLines = () => BODY.map((b) => b.title || b.note || b.head
  || b.p.map((x) => (typeof x === 'string' ? x : x.text)).join(''));
