// Typed react-redux hooks for components (features, screens).

import { useDispatch, useSelector } from 'react-redux';
import type { Dispatch } from 'redux';
import type { Action, State } from './types.ts';

export const useAppDispatch = useDispatch.withTypes<Dispatch<Action>>();
export const useAppSelector = useSelector.withTypes<State>();
