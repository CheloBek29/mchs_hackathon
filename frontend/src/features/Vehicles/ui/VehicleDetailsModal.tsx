import React from 'react';
import { PixelButton } from '../../../shared/ui/PixelButton';
import { PixelModal } from '../../../shared/ui/PixelModal';
import { StatusIndicator } from '../../../shared/ui/StatusIndicator';
import type { VehicleRuntimeItem } from '../model/useVehicleRuntime';

interface VehicleDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  vehicle: VehicleRuntimeItem | null;
  primaryActionLabel?: string;
  onPrimaryAction?: (vehicle: VehicleRuntimeItem) => void;
  primaryActionDisabled?: boolean;
  primaryActionLoading?: boolean;
}

export const VehicleDetailsModal: React.FC<VehicleDetailsModalProps> = ({
  isOpen,
  onClose,
  vehicle,
  primaryActionLabel,
  onPrimaryAction,
  primaryActionDisabled,
  primaryActionLoading,
}) => {
  return (
    <PixelModal isOpen={isOpen} onClose={onClose} title={vehicle?.name}>
      {vehicle ? (
        <div className="flex flex-col gap-3 font-pixel text-[8px] uppercase">
          <svg viewBox="0 0 553 265" className="w-full border-2 border-black mb-2 bg-[#111]">
            <image
              href="/assets/vehicles_sprite.png"
              width="2212"
              height="1534"
              x={-(vehicle.col * 553)}
              y={-(vehicle.row * 767) - 75}
            />
          </svg>

          <div className="flex justify-between items-center bg-[#202020] p-2 border-2 border-black">
            <span className="text-gray-400">Статус:</span>
            <div className="flex items-center gap-2">
              <span className={vehicle.isBusy ? 'text-orange-300' : 'text-green-400'}>{vehicle.statusLabel}</span>
              <StatusIndicator color={vehicle.indicatorColor} />
            </div>
          </div>

          <div className="flex justify-between items-center border-b border-gray-600 pb-1">
            <span className="text-gray-400">Тип:</span>
            <span>{vehicle.typeLabel}</span>
          </div>
          <div className="flex justify-between items-center border-b border-gray-600 pb-1">
            <span className="text-gray-400">Экипаж:</span>
            <span>{vehicle.crew_size != null ? `${vehicle.crew_size} чел.` : '-'}</span>
          </div>
          <div className="flex justify-between items-center border-b border-gray-600 pb-1">
            <span className="text-gray-400">Вода:</span>
            <span>{vehicle.water_capacity != null ? `${vehicle.water_capacity} л` : '-'}</span>
          </div>
          <div className="flex justify-between items-center border-b border-gray-600 pb-1">
            <span className="text-gray-400">Пена:</span>
            <span>{vehicle.foam_capacity != null ? `${vehicle.foam_capacity} л` : '-'}</span>
          </div>
          <div className="flex justify-between items-center border-b border-gray-600 pb-1">
            <span className="text-gray-400">Рукава:</span>
            <span>{vehicle.hose_length != null ? `${vehicle.hose_length} м` : '-'}</span>
          </div>

          <div className="flex gap-2 mt-2">
            <PixelButton variant="active" className="flex-1 text-[7px]" onClick={onClose}>
              ЗАКРЫТЬ
            </PixelButton>
            {primaryActionLabel && onPrimaryAction ? (
              <PixelButton
                variant="green"
                className="flex-1 text-[7px]"
                disabled={primaryActionDisabled || primaryActionLoading}
                onClick={() => onPrimaryAction(vehicle)}
              >
                {primaryActionLoading ? 'ОТПРАВКА...' : primaryActionLabel}
              </PixelButton>
            ) : null}
          </div>
        </div>
      ) : null}
    </PixelModal>
  );
};
