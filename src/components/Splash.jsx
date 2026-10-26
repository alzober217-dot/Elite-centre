import { useEffect, useRef, useState } from 'react';
import './Splash.css';

const LEFT_LINES = [78, 64, 82, 58, 72];
const RIGHT_LINES = [70, 84, 60, 76, 66];

export default function Splash({ onFinish, duration = 5200 }) {
  const [hide, setHide] = useState(false);
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;

  useEffect(() => {
    const t1 = setTimeout(() => setHide(true), duration);
    const t2 = setTimeout(() => finishRef.current && finishRef.current(), duration + 600);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [duration]);

  const renderLines = (widths, offset) =>
    widths.map((w, i) => (
      <span
        key={i}
        className="splash-line"
        style={{ width: `${w}%`, '--i': offset + i }}
      />
    ));

  return (
    <div className={`splash ${hide ? 'splash--hide' : ''}`}>
      <div className="splash-title">
        <h1>SVS</h1>
        <p>TECHNOLOGY</p>
      </div>

      <div className="splash-divider" />

      <div className="splash-book">
        <div className="splash-glow" />
        <div className="splash-cover">
          <div className="splash-pages">
            <div className="splash-page splash-page--left">
              {renderLines(LEFT_LINES, 0)}
            </div>
            <div className="splash-spine" />
            <div className="splash-page splash-page--right">
              {renderLines(RIGHT_LINES, LEFT_LINES.length)}
            </div>
          </div>
        </div>
        <div className="splash-ribbon" />
      </div>
    </div>
  );
}
