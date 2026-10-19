import keplerGlReducer, { enhanceReduxMiddleware, uiStateUpdaters } from "@kepler.gl/reducers";
import { initApplicationConfig } from "@kepler.gl/utils";
import { applyMiddleware, combineReducers, compose, createStore } from "redux";

initApplicationConfig({ enableAnnotations: false });

const off = { show: false, active: false };
const D = uiStateUpdaters.DEFAULT_MAP_CONTROLS;

const reducers = combineReducers({
  keplerGl: keplerGlReducer.initialState({
    mapStyle: { styleType: "dark-matter" },
    uiState: {
      readOnly: false,
      currentModal: null,
      activeSidePanel: null, // map-first; the layer panel opens from the top-left toggle
      mapControls: {
        ...D,
        mapLegend: { ...D.mapLegend, show: true, active: true },
        toggle3d: { ...D.toggle3d, show: true },
        visibleLayers: { ...D.visibleLayers, show: true },
        splitMap: off, mapDraw: off, mapLocale: off, mapTheme: off, effect: off, annotation: off, viewportJson: off,
      },
    },
  }),
});

export const keplerStore = createStore(reducers, {}, compose(applyMiddleware(...enhanceReduxMiddleware([]))));
export type KeplerRoot = ReturnType<typeof keplerStore.getState>;
