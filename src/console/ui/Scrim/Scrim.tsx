// Backdrop under a modal or a sheet (design: .scrim). A click on it is the
// "cancel" of the overlay above.

import './Scrim.css';

export function Scrim({ onClick }: { onClick?: () => void }) {
  return <div className="scrim" onClick={onClick} />;
}
