import { useEffect, useState } from "react";
import { fetchPlainLabelTypesApi, fetchPlainUsersApi } from "../lib/api";
import { errorMessage } from "../lib/error-message";
import type { PlainLabelType, PlainWorkspaceUser } from "../lib/types";

/**
 * Plain's teammates and label kinds, for the Assign and Labels menus.
 *
 * The server caches both for minutes, and they change about as often, so one
 * request per page load is shared by every menu that needs them: the ticket
 * bar and each queue row's right-click menu. A failed request is forgotten so
 * the next menu to mount tries again.
 */
interface Loaded<T> {
  data: T | null;
  error: string | null;
}

let usersRequest: Promise<PlainWorkspaceUser[]> | null = null;
let labelTypesRequest: Promise<PlainLabelType[]> | null = null;

function loadUsers() {
  usersRequest ??= fetchPlainUsersApi().catch((error) => {
    usersRequest = null;
    throw error;
  });
  return usersRequest;
}

function loadLabelTypes() {
  labelTypesRequest ??= fetchPlainLabelTypesApi().catch((error) => {
    labelTypesRequest = null;
    throw error;
  });
  return labelTypesRequest;
}

function useLoaded<T>(load: () => Promise<T>, fallback: string): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ data: null, error: null });
  useEffect(() => {
    let alive = true;
    load()
      .then((data) => {
        if (alive) setState({ data, error: null });
      })
      .catch((error) => {
        if (alive)
          setState({ data: null, error: errorMessage(error, fallback) });
      });
    return () => {
      alive = false;
    };
  }, [load, fallback]);
  return state;
}

export function usePlainDirectory() {
  const users = useLoaded(loadUsers, "Failed to load Plain users");
  const labelTypes = useLoaded(loadLabelTypes, "Failed to load Plain labels");
  return {
    users: users.data,
    usersError: users.error,
    labelTypes: labelTypes.data,
    labelTypesError: labelTypes.error,
  };
}
