import { jsPDF } from "jspdf";
import QRCode from "qrcode";

export function buildQrDataUrl(url, { width = 960 } = {}) {
  return QRCode.toDataURL(String(url || ""), {
    margin: 1,
    width,
    errorCorrectionLevel: "M",
    color: { dark: "#0f172a", light: "#ffffff" }
  });
}

export function downloadQrPdf({
  dataUrl,
  title,
  subtitle,
  filename
}) {
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const qrSize = 90;
  const qrX = (pageWidth - qrSize) / 2;
  const qrY = 40;
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(18);
  pdf.text(String(title || "Menú"), pageWidth / 2, 24, { align: "center" });
  pdf.addImage(dataUrl, "PNG", qrX, qrY, qrSize, qrSize);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(12);
  pdf.text(String(subtitle || "Escaneá para ver el menú"), pageWidth / 2, qrY + qrSize + 12, {
    align: "center"
  });
  pdf.save(String(filename || "qr-menu.pdf"));
}

export function downloadDataUrlAsPng(dataUrl, filename) {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = String(filename || "qr-menu.png");
  link.click();
}
