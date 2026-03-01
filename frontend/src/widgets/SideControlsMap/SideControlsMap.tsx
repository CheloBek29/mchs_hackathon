import React, { useState } from 'react';
import { PixelButton } from '../../shared/ui/PixelButton';
import { PixelInput } from '../../shared/ui/PixelInput';
import { PixelCheckbox } from '../../shared/ui/PixelCheckbox';
import { StatusIndicator } from '../../shared/ui/StatusIndicator';
import { PixelModal } from '../../shared/ui/PixelModal';
import { useSimulationStore, type SpeedMultiplier } from '../../entities/SimulationState/model/store';

// Extended list of cars with mock details for popups
// Added col and row mapping based on vehicles_sprite.png
const RTP_VEHICLES = [
    { name: 'АЦ-40', phone: '89237612034', status: 'На базе', crew: 4, water: '2350 л', foam: '165 л', type: 'Автоцистерна', state: 'free', col: 0, row: 0 },
    { name: 'АЦ-3, 2-40/4', phone: '89237612034', status: 'В пути', crew: 4, water: '3200 л', foam: '200 л', type: 'Автоцистерна', state: 'busy', col: 1, row: 0 },
    { name: 'АЦ-6,0-40', phone: '89237612034', status: 'На месте', crew: 4, water: '6000 л', foam: '360 л', type: 'Автоцистерна', state: 'busy', col: 2, row: 0 },
    { name: 'ПНС-110', phone: '89237612034', status: 'На базе', crew: 0, water: '-', foam: '-', type: 'Насосная станция', state: 'free', col: 3, row: 0 },
    { name: 'АЛ-30', phone: '89237612034', status: 'На базе', crew: 0, water: '-', foam: '-', type: 'Автолестница', state: 'free', col: 0, row: 1 },
    { name: 'АЛ-50', phone: '89237612034', status: 'На месте', crew: 0, water: '-', foam: '-', type: 'Автолестница', state: 'busy', col: 1, row: 1 },
    { name: 'АНР-3,0 -100', phone: '89237612034', status: 'На базе', crew: 0, water: '-', foam: '-', type: 'РХБЗ', state: 'free', col: 2, row: 1 },
    { name: 'АР-2', phone: '89237612034', status: 'В пути', crew: 0, water: '-', foam: '-', type: 'Рукавный автомобиль', state: 'busy', col: 3, row: 1 },
];

// For this stage we will just mock the layout of the sidebar
export const SideControlsMap: React.FC = () => {
    const store = useSimulationStore();
    const [selectedVehicle, setSelectedVehicle] = useState<typeof RTP_VEHICLES[0] | null>(null);

    return (
        <div className="w-[320px] h-full bg-[#2b2b2b] flex flex-col shrink-0 border-r-2 border-black overflow-y-auto custom-scrollbar relative">

            <div className="p-4 flex-1 flex flex-col gap-6">

                {/* Графические инструменты */}
                <section>
                    <h2 className="text-[10px] text-white uppercase mb-3 font-pixel">Графические инструменты</h2>
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                            <span className="text-[8px] uppercase">Очаг огня</span>
                            <StatusIndicator color="red" />
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-[8px] uppercase">Зоны пожара</span>
                            <StatusIndicator color="orange" />
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-[8px] uppercase">Зоны задымления</span>
                            <StatusIndicator color="gray" />
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-[8px] uppercase text-gray-400">Зоны температурного воздействия</span>
                            <StatusIndicator color="blue" />
                        </div>
                    </div>
                </section>

                {/* Метеоусловия */}
                <section>
                    <h2 className="text-[10px] text-white uppercase mb-3 font-pixel">Метеоусловия</h2>
                    <div className="flex flex-col gap-2 relative">
                        <div className="flex items-center justify-between">
                            <span className="text-[8px] uppercase">Ветер</span>
                            {/* Space reserved for a potential wind indicator */}
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-[8px] uppercase">Температура</span>
                            <div className="flex items-center gap-1">
                                <PixelInput
                                    className="w-12 text-right"
                                    value={store.temperature}
                                    onChange={(e) => store.setTemperature(e.target.value)}
                                />
                                <span className="text-[8px]">°C</span>
                            </div>
                        </div>
                    </div>
                </section>

                {/* Время суток */}
                <section>
                    <h2 className="text-[10px] text-white uppercase mb-3 font-pixel">Время суток</h2>
                    <div className="flex items-center gap-1">
                        <PixelInput
                            className="w-8 h-6 text-center"
                            value={store.timeHours}
                            onChange={(e) => store.setTime(e.target.value, store.timeMinutes)}
                        />
                        <span>:</span>
                        <PixelInput
                            className="w-8 h-6 text-center"
                            value={store.timeMinutes}
                            onChange={(e) => store.setTime(store.timeHours, e.target.value)}
                        />
                    </div>
                </section>

                {/* Увеличить скорость */}
                <section>
                    <h2 className="text-[10px] text-white uppercase mb-3 font-pixel flex justify-between items-center">
                        Увеличить скорость
                        <PixelCheckbox className="ml-2" />
                    </h2>
                    <div className="flex gap-1">
                        {(['2X', '3X', '5X', '10X', '20X'] as SpeedMultiplier[]).map((sp) => (
                            <PixelButton
                                key={sp}
                                size="sm"
                                variant={store.speed === sp ? 'active' : 'default'}
                                className="flex-1"
                                onClick={() => store.setSpeed(sp)}
                            >
                                {sp}
                            </PixelButton>
                        ))}
                    </div>
                </section>

                {/* Состояние систем противопожарного водоснабжения */}
                <section>
                    <h2 className="text-[10px] text-white uppercase mb-3 font-pixel leading-tight">
                        Состояние систем<br />противопожарного<br />водоснабжения
                    </h2>
                    <PixelButton className="w-full text-center py-2 text-[10px]">
                        ИСПРАВНЫ
                    </PixelButton>
                </section>

                {/* Внештатные ситуации */}
                <section>
                    <h2 className="text-[10px] text-white uppercase mb-3 font-pixel">Внештатные ситуации</h2>
                    <div className="flex flex-col gap-3">
                        <div className="flex items-center justify-between">
                            <span className="text-[8px] uppercase">Отказ техники</span>
                            <PixelCheckbox
                                checked={store.equipmentFailure}
                                onChange={(e) => store.setEquipmentFailure(e.target.checked)}
                            />
                        </div>

                        <div className="flex flex-col gap-1">
                            <div className="flex items-center justify-between">
                                <span className="text-[8px] uppercase">Изменение направления ветра</span>
                                <PixelCheckbox
                                    checked={store.windDirChange}
                                    onChange={(e) => store.setWindDirChange(e.target.checked)}
                                />
                            </div>
                            <div className="flex items-center pl-4 gap-2">
                                <span className="text-[6px] text-gray-400 uppercase">Направление ветра</span>
                                <PixelInput
                                    className="w-8 h-4 text-[8px] px-1"
                                    value={store.windDirectionDegree}
                                    onChange={(e) => store.setWindDirectionDegree(e.target.value)}
                                    disabled={!store.windDirChange}
                                />
                                <span className="text-[6px]">°</span>
                            </div>
                        </div>

                        <div className="flex items-center justify-between mt-2">
                            <span className="text-[8px] uppercase">Увеличение площади пожара</span>
                            <PixelCheckbox
                                checked={store.fireAreaIncrease}
                                onChange={(e) => store.setFireAreaIncrease(e.target.checked)}
                            />
                        </div>
                    </div>
                </section>

                {/* Техника */}
                <section className="mb-20"> {/* Bottom margin for sticky button */}
                    <h2 className="text-[10px] text-white uppercase mb-3 font-pixel flex items-center gap-1 cursor-pointer">
                        Техника
                        <span className="text-[8px]">▼</span>
                    </h2>
                    <div className="flex flex-col gap-2">
                        {RTP_VEHICLES.map((v, i) => (
                            <div key={i} className="flex items-center justify-between">
                                <span className="text-[7px] uppercase whitespace-nowrap overflow-hidden text-ellipsis w-[110px]" title={v.name}>{v.name}</span>
                                <PixelButton
                                    variant="green"
                                    className="text-[6px] h-4 px-2 tracking-tighter shrink-0 active:scale-95 transition-transform"
                                    onClick={() => setSelectedVehicle(v)}
                                >
                                    изменить данные
                                </PixelButton>
                            </div>
                        ))}
                    </div>

                    <div className="mt-4">
                        <PixelButton variant="green" className="py-2 px-4 shadow-[inset_2px_2px_0_rgba(255,255,255,0.3),inset_-2px_-2px_0_rgba(0,0,0,0.4)]">
                            ВИД СВЕРХУ
                        </PixelButton>
                    </div>
                </section>

            </div>

            {/* Sticky Bottom Save Button */}
            <div className="sticky bottom-0 left-0 w-full p-4 bg-gradient-to-t from-[#202020] via-[#202020] to-transparent pt-8 mt-auto">
                <PixelButton variant="green" className="w-full text-center py-3">
                    СОХРАНИТЬ ИЗМЕНЕНИЯ
                </PixelButton>
            </div>

            {/* RTP Vehicle Editor Modal Popup */}
            <PixelModal
                isOpen={selectedVehicle !== null}
                onClose={() => setSelectedVehicle(null)}
                title={selectedVehicle?.name}
            >
                {selectedVehicle && (
                    <div className="flex flex-col gap-3 font-pixel text-[8px] uppercase">

                        {/* Image Crop using SVG Sprite Technique */}
                        <svg viewBox="0 0 553 265" className="w-full border-2 border-black mb-2 bg-[#111]">
                            <image
                                href="/assets/vehicles_sprite.png"
                                width="2212"
                                height="1534"
                                x={-(selectedVehicle.col * 553)}
                                y={-(selectedVehicle.row * 767) - 75}
                            />
                        </svg>

                        {/* RTP specific details based on example.png */}
                        <div className="flex flex-col gap-1 tracking-wider leading-relaxed">
                            {selectedVehicle.water !== '-' && (
                                <div className="flex gap-1">
                                    <span>Объем воды —</span>
                                    <span>{selectedVehicle.water}.</span>
                                </div>
                            )}
                            {selectedVehicle.foam !== '-' && (
                                <div className="flex gap-1 mb-1">
                                    <span>Объем пены —</span>
                                    <span>{selectedVehicle.foam}.</span>
                                </div>
                            )}

                            {/* Static mocked stats as seen in the screenshot */}
                            <div className="flex gap-1">
                                <span>Рукава 77 —</span>
                                <span>11шт</span>
                            </div>
                            <div className="flex gap-1 mb-1">
                                <span>Рукава 51 —</span>
                                <span>6шт.</span>
                            </div>

                            <div className="flex gap-1">
                                <span>Подача насоса —</span>
                                <span>40л/c</span>
                            </div>
                            <div className="flex gap-1 mb-1">
                                <span>Количество пожарных —</span>
                                <span>{selectedVehicle.crew}чел.</span>
                            </div>

                            <div className="flex flex-col gap-1 w-full">
                                <span>Ствол РСКУ-50 —</span>
                                <span className="ml-2">расход воды (2-4-6-8л/с)</span>
                            </div>
                            <div className="flex flex-col gap-1 w-full mt-1">
                                <span>Ствол РСКУ-70 —</span>
                                <span className="ml-2">(6-9-12-15л/с)</span>
                            </div>
                        </div>

                        {/* Action buttons inside popup */}
                        <div className="w-full mt-4">
                            <PixelButton variant="green" className="w-full text-[10px] py-2 tracking-widest text-[#2b2b2b] font-bold" onClick={() => setSelectedVehicle(null)}>
                                ИЗМЕНИТЬ
                            </PixelButton>
                        </div>
                    </div>
                )}
            </PixelModal>

        </div>
    );
};
