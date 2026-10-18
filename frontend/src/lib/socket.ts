"use client";

import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API_URL, loadSession } from "./api";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(API_URL || undefined, {
      path: "/socket.io",
      transports: ["websocket"],
      // Function form: every (re)connect picks up the latest refreshed token
      auth: (cb) => cb({ token: loadSession()?.access_token }),
      reconnectionDelayMax: 5000,
    });
  }
  return socket;
}

export function closeSocket() {
  socket?.disconnect();
  socket = null;
}

export function useSocket() {
  const [s, setS] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const sock = getSocket();
    setS(sock);
    setConnected(sock.connected);
    const on = () => setConnected(true);
    const off = () => setConnected(false);
    sock.on("connect", on);
    sock.on("disconnect", off);
    return () => {
      sock.off("connect", on);
      sock.off("disconnect", off);
    };
  }, []);
  return { socket: s, connected };
}

/** Subscribe to a socket event for the lifetime of the component. */
export function useSocketEvent<T>(event: string, handler: (data: T) => void) {
  useEffect(() => {
    const sock = getSocket();
    sock.on(event, handler);
    return () => {
      sock.off(event, handler);
    };
  }, [event, handler]);
}
