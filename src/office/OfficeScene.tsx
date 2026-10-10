import type { CSSProperties } from 'react';
import type { AreaId, OfficeCase } from './contracts';
import { AREAS } from './areas';
import { deriveAreaStatus } from './model';

function Plant({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return <g transform={`translate(${x} ${y}) scale(${scale})`}><ellipse cy="8" rx="17" ry="9" fill="#2f4435" opacity=".1" /><path d="M-12-10 12-10 8 9-8 9Z" fill="#b68058" /><ellipse cy="-10" rx="12" ry="6" fill="#d9b494" /><path d="M0-10 Q-2-28 0-44 M0-24 Q-22-45-24-27 Q-17-17 0-21 M0-30 Q20-56 22-38 Q15-25 0-26 M0-40 Q-10-62-14-53 Q-16-41 0-35" fill="#557757" stroke="#446044" strokeWidth="2" /></g>;
}
function Person({ x, y, color, hair = '#59453b' }: { x: number; y: number; color: string; hair?: string }) {
  return <g transform={`translate(${x} ${y})`}><ellipse cy="8" rx="15" ry="7" fill="#3e3c32" opacity=".12" /><path d="M-6 3-8-17 8-17 7 3" stroke="#343f3b" strokeWidth="5" fill="none" /><path d="M-13-21 Q-14-40 0-41 Q14-40 13-21Z" fill={color} /><path d="M-12-34-20-21 M12-34 20-21" stroke={color} strokeWidth="6" strokeLinecap="round" /><circle cy="-51" r="11" fill="#d6a987" /><path d="M-11-51 Q-13-66 0-65 Q14-65 11-51 L6-56 Q0-50-8-56Z" fill={hair} /><circle cx="4" cy="-51" r="1" fill="#624735" /></g>;
}
function Desk({ x, y, color = '#b08661', laptop = true }: { x: number; y: number; color?: string; laptop?: boolean }) {
  return <g transform={`translate(${x} ${y})`}><path d="M-58 5-58 35 M38 5 38 35 M65-12 65 18" stroke="#7b624b" strokeWidth="5" /><path d="M-67-19 4-52 73-19 2 15Z" fill={color} /><path d="M-67-19 2 15 2 22-67-12Z" fill="#977150" /><path d="M2 15 73-19 73-12 2 22Z" fill="#765b43" />{laptop && <><path d="M-29-35 6-51 11-23-24-7Z" fill="#344a43" /><path d="M-25-33 3-46 7-25-20-12Z" fill="#bdd3c5" /><path d="M-24-7 11-23 33-12-2 4Z" fill="#d6d7c8" /><path d="M-16-8 10-20 25-12-2 0Z" fill="#b5bdb0" /></>}<path d="M32-34 47-41 58-35 43-28Z" fill="#f2e5d4" /><path d="M38-33 50-38" stroke="#b7a086" strokeWidth="1.5" /><ellipse cx="-43" cy="-16" rx="7" ry="4" fill="#f6eedc" /><path d="M-50-16V-8 Q-43-3-36-8V-16" fill="#f6eedc" /></g>;
}

export function OfficeScene({ selected, onSelect, current }: { selected: AreaId; onSelect: (area: AreaId) => void; current: OfficeCase | null }) {
  return <div className="office-scene" aria-label="Oficina isométrica: selecciona una función">
    <svg viewBox="0 0 900 580" role="img" aria-labelledby="office-art-title office-art-desc">
      <title id="office-art-title">La oficina virtual de Gourmet</title><desc id="office-art-desc">Ilustración original con escritorios de ventas y finanzas, mesa de coordinación, cocina y espacio de dirección. Los botones de cada área permiten navegar.</desc>
      <defs><linearGradient id="floor" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#e7decb" /><stop offset="1" stopColor="#d5c9b0" /></linearGradient><linearGradient id="wall" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#fff9ec" /><stop offset="1" stopColor="#e8dfcc" /></linearGradient><filter id="shadow" x="-30%" y="-30%" width="160%" height="180%"><feGaussianBlur stdDeviation="12" /></filter></defs>
      <ellipse cx="450" cy="458" rx="350" ry="90" fill="#576b55" opacity=".12" filter="url(#shadow)" />
      <path d="M94 277 449 100 805 277 450 455Z" fill="#b7ac96" /><path d="M94 277 450 455 450 479 94 301Z" fill="#c2b395" /><path d="M450 455 805 277 805 301 450 479Z" fill="#9f947e" /><path d="M94 277 449 100 805 277 450 455Z" fill="url(#floor)" />
      {[0,1,2,3,4,5,6].map(i=><g key={i} stroke="#baaa8d" opacity=".3"><path d={`M${94+i*51} ${277-i*25.3} ${450+i*51} ${455-i*25.3}`} /><path d={`M${94+i*51} ${277+i*25.4} ${450+i*51} ${100+i*25.4}`} /></g>)}
      <path d="M94 277 94 136 449-40 449 100Z" fill="url(#wall)" transform="translate(0 100)" /><path d="M449 100 449-40 805 136 805 277Z" fill="#e1d8c5" transform="translate(0 0)" />
      <path d="M94 277 449 100 449-40" fill="none" stroke="#c0af90" strokeWidth="5" /><path d="M449-40 805 136" stroke="#c0af90" strokeWidth="5" />
      <path d="M133 204V143L222 99V160Z" fill="#729181" /><path d="M142 196V148L214 113V160Z" fill="#b7cbb7" /><path d="M178 178V132" stroke="#f7efdc" strokeWidth="5" /><path d="M142 170 213 135" stroke="#f7efdc" strokeWidth="5" />
      <path d="M262 139V79L350 35V95Z" fill="#729181" /><path d="M270 128V83L343 47V94Z" fill="#c7d9bd" /><path d="M307 110V65" stroke="#f7efdc" strokeWidth="5" />
      <path d="M515 39 572 67 572 118 515 90Z" fill="#b9996f" /><path d="M522 48 565 69 565 107 522 85Z" fill="#f5ebd9" /><path d="M531 75 542 57 556 82 547 82 543 91Z" fill="#6f8461" />
      <path d="M669 136 760 181 760 192 669 146Z" fill="#ac8d6a" /><path d="M680 129V101L703 112V140Z" fill="#6d8263" /><path d="M710 145V122L728 131V154Z" fill="#c08456" /><path d="M735 159V139L748 145V166Z" fill="#ddd0b4" />
      <path d="M332 158 449 100 571 161 451 221Z" fill="#a8b9a4" /><path d="M341 158 449 105 561 161 451 214Z" fill="none" stroke="#e1e8d9" strokeWidth="2" />
      <Desk x={450} y={142} color="#83674b" /><Person x={451} y={114} color="#365646" /><Plant x={364} y={134} scale={.65} /><Plant x={543} y={132} scale={.7} />
      <path d="M137 286 266 222 364 271 235 335Z" fill="#d5b09a" /><path d="M152 286 266 230 349 272 236 328Z" fill="none" stroke="#ead1b7" strokeWidth="3" />
      <Desk x={249} y={268} /><Person x={256} y={225} color="#c8794d" /><path d="M198 286 198 306 217 314 217 295Z" fill="#638071" /><path d="M198 286 214 278 233 287 217 295Z" fill="#80a08c" /><path d="M217 295 233 287 233 307 217 314Z" fill="#4c6b5c" />
      <Plant x={132} y={279} /><Plant x={342} y={227} scale={.8} />
      <path d="M537 254 655 195 768 253 650 313Z" fill="#abb8c5" /><Desk x={656} y={251} color="#bbab8a" /><Person x={664} y={211} color="#697ba3" hair="#453830" />
      <path d="M579 223 579 190 609 205 609 238Z" fill="#9b886e" /><path d="M579 190 601 179 631 194 609 205Z" fill="#c9b899" /><path d="M609 205 631 194 631 228 609 238Z" fill="#b2a181" /><path d="M613 212 627 205 M613 222 627 215" stroke="#e8decb" strokeWidth="2" /><Plant x={773} y={278} scale={.9} />
      <path d="M246 354 355 300 471 358 361 413Z" fill="#a3b29a" /><path d="M280 348 357 310 435 348 357 387Z" fill="#a0825d" /><path d="M280 348 357 387 357 396 280 357Z" fill="#886947" /><path d="M357 387 435 348 435 357 357 396Z" fill="#725838" /><path d="M294 357 294 378 M420 357 420 378" stroke="#725838" strokeWidth="4" />
      <Person x={357} y={327} color="#597b69" /><path d="M320 346 346 333 371 345 345 358Z" fill="#f7f0de" /><path d="M331 345 347 338 M337 350 358 340" stroke="#afa58f" strokeWidth="2" /><path d="M385 349 399 342 411 348 397 355Z" fill="#ddb772" /><Plant x={245} y={374} scale={.65} />
      <path d="M486 365 604 306 699 354 581 414Z" fill="#c4bb97" /><path d="M498 319 593 271 689 319 594 367Z" fill="#eee4d0" /><path d="M498 319 594 367 594 406 498 358Z" fill="#92a18b" /><path d="M594 367 689 319 689 357 594 406Z" fill="#637962" />
      <path d="M502 317 593 272 686 319 594 364Z" fill="#b8b8a2" /><path d="M520 317 554 300 587 317 553 334Z" fill="#5e6960" /><ellipse cx="552" cy="314" rx="13" ry="7" fill="#b6c3b8" /><ellipse cx="552" cy="311" rx="11" ry="6" fill="#edf0dd" /><path d="M599 304 625 291 654 306 628 319Z" fill="#ded6bd" /><ellipse cx="623" cy="305" rx="10" ry="5" fill="#839386" /><path d="M613 304 612 291 Q615 284 619 289V296" fill="none" stroke="#869c91" strokeWidth="4" />
      <path d="M510 343 583 380 M602 383 675 346" stroke="#d4ddc9" strokeWidth="1.5" /><path d="M548 360 548 380 M633 368 633 387" stroke="#d4ddc9" strokeWidth="2" /><Person x={705} y={326} color="#b28b48" /><path d="M695 272 Q692 261 701 258 Q705 246 715 257 Q728 255 727 269L719 279Z" fill="#faf2df" /><Plant x={576} y={417} scale={.6} />
      <path d="M381 435 450 401 519 435 450 469Z" fill="#597b69" /><path d="M394 435 450 408 506 435 450 462Z" fill="none" stroke="#c4d2b7" strokeWidth="1.5" /><text x="450" y="443" textAnchor="middle" fill="#eee7d2" fontFamily="Georgia,serif" fontSize="20" transform="rotate(-1 450 440)">G</text>
      <Plant x={88} y={331} scale={1.1} /><Plant x={811} y={330} scale={1.15} />
    </svg>
    {AREAS.map(area => <button key={area.id} style={{ left: `${area.x}%`, top: `${area.y}%`, '--area-color': area.color } as CSSProperties} className={`room-pin ${selected === area.id ? 'selected' : ''}`} aria-label={`Seleccionar ${area.name}`} aria-pressed={selected === area.id} onClick={() => onSelect(area.id)}><span className={`room-dot ${current ? deriveAreaStatus(current, area.id) : 'blocked'}`} /><span>{area.short}</span><span className="pin-arrow" aria-hidden="true">↗</span></button>)}
    <div className="office-art-note"><span className="scene-key" /> Funciones virtuales · un operador humano</div>
  </div>;
}
