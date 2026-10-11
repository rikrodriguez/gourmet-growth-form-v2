import { useId } from 'react';
import type { CSSProperties } from 'react';
import type { FunctionId, OfficeCase } from './contracts';
import { departmentById } from './presentation';
import approvedOfficeScene from './assets/approved-office-scene.png';

const ART_WIDTH = 959;
const ART_HEIGHT = 799;

// Centers and pill sizes are measured in the approved scene crop, not the
// complete application screenshot. Domain AreaId values remain unchanged.
const SCENE_DEPARTMENTS = [
  { id: 'sales', x: 248, y: 250, width: 130, height: 42 },
  { id: 'marketing', x: 576, y: 180, width: 132, height: 42 },
  { id: 'operations', x: 329, y: 402, width: 146, height: 42 },
  { id: 'suppliers', x: 196, y: 610, width: 150, height: 42 },
  { id: 'finance', x: 631, y: 578, width: 116, height: 42 },
  { id: 'quality', x: 845, y: 348, width: 114, height: 42 },
] as const;

export function OfficeScene({ functionId, onSelect, current }: {
  functionId: FunctionId;
  onSelect: (functionId: FunctionId) => void;
  current: OfficeCase | null;
}) {
  const captionId = useId();
  return <figure className="office-scene approved-office-scene" aria-describedby={captionId}>
    <div className="office-scene-canvas" style={{ '--scene-aspect-ratio': `${ART_WIDTH} / ${ART_HEIGHT}` } as CSSProperties}>
      {/* Approved artwork only: raster bubbles, people and marks are decorative.
          Real department controls and selection are HTML, not image hit maps. */}
      <img
        className="office-scene-art"
        src={approvedOfficeScene}
        width={ART_WIDTH}
        height={ART_HEIGHT}
        alt=""
        aria-hidden="true"
        draggable={false}
        decoding="async"
        fetchPriority="high"
      />
      <div
        className="office-department-controls"
        role="group"
        aria-label={current ? `Departamentos de la oficina · ${current.title}` : 'Departamentos de la oficina'}
      >
        {SCENE_DEPARTMENTS.map(position => {
          const department = departmentById(position.id);
          const selected = department.functionIds.includes(functionId);
          const style = {
            '--department-x': `${position.x / ART_WIDTH * 100}%`,
            '--department-y': `${position.y / ART_HEIGHT * 100}%`,
            '--department-width': `${position.width / ART_WIDTH * 100}%`,
            '--department-height': `${position.height / ART_HEIGHT * 100}%`,
            '--department-color': department.color,
          } as CSSProperties;
          return <button
            key={department.id}
            type="button"
            className={`office-department-button${selected ? ' is-selected' : ''}`}
            style={style}
            data-department={department.id}
            aria-label={`Seleccionar ${department.name}`}
            aria-pressed={selected}
            onClick={() => onSelect(department.primaryFunctionId)}
          >
            <span className="office-department-dot" aria-hidden="true" />
            <span className="office-department-label">{department.name}</span>
          </button>;
        })}
      </div>
    </div>
    <figcaption id={captionId} className="office-scene-caption">Ilustración DEMO · personajes, iconos y contadores decorativos.</figcaption>
  </figure>;
}
