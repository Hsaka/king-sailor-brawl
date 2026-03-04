import { CONFIG } from '../config.js';

export class ShipDefinitions {
    static get(shipId) {
        return CONFIG.SHIPS.find(s => s.id === shipId) || CONFIG.SHIPS[0];
    }
}
