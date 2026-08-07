import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** The QR encodes the same join URL the 4-character code spells out (§1). */
export function QrCode({ url, size = 200 }: { url: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    QRCode.toDataURL(url, {
      width: size * 2, // rendered at 2× for retina phones
      margin: 1,
      color: { dark: '#0f1720ff', light: '#ffffffff' },
    })
      .then((out) => {
        if (live) setDataUrl(out);
      })
      .catch(() => setDataUrl(null));
    return () => {
      live = false;
    };
  }, [url, size]);

  if (!dataUrl) return <div className="qr qr--placeholder" style={{ width: size, height: size }} />;
  return <img className="qr" src={dataUrl} alt={`QR code to join at ${url}`} width={size} height={size} />;
}
