import { describe, expect, it, vi } from "vitest";
import {
  renderOfficialGoogleButton,
  type GisButtonConfiguration,
  type GisIdentityConfiguration,
  type GoogleIdentityApi,
} from "./google-identity";

function setup(width = 280) {
  let initializeConfig: GisIdentityConfiguration | undefined;
  let rendered: { parent: HTMLElement; options: GisButtonConfiguration } | undefined;
  const replaceChildren = vi.fn();
  const host = { clientWidth: width, replaceChildren } as unknown as HTMLElement;
  const api: GoogleIdentityApi = {
    initialize: vi.fn(config => { initializeConfig = config; }),
    renderButton: vi.fn((parent, options) => { rendered = { parent, options }; }),
  };
  const onCredential = vi.fn();
  const onError = vi.fn();

  renderOfficialGoogleButton({
    api,
    host,
    clientId: "client.apps.googleusercontent.com",
    onCredential,
    onError,
  });

  return { api, host, initializeConfig, rendered, replaceChildren, onCredential, onError };
}

describe("Google Identity Services button", () => {
  it("uses the official GIS renderButton API with the expected localized style", () => {
    const result = setup();

    expect(result.api.initialize).toHaveBeenCalledOnce();
    expect(result.replaceChildren).toHaveBeenCalledOnce();
    expect(result.rendered?.parent).toBe(result.host);
    expect(result.rendered?.options).toMatchObject({
      type: "standard",
      theme: "outline",
      size: "large",
      text: "signin_with",
      locale: "vi",
      width: 280,
    });
  });

  it("forwards only a valid credential and reports an empty GIS response", () => {
    const result = setup();
    result.initializeConfig?.callback({ credential: "google-id-token" });
    result.initializeConfig?.callback({});

    expect(result.onCredential).toHaveBeenCalledWith("google-id-token");
    expect(result.onError).toHaveBeenCalledWith(
      "Google không trả về thông tin đăng nhập hợp lệ.",
    );
  });

  it("keeps official button width within Google's supported mobile bounds", () => {
    expect(setup(120).rendered?.options.width).toBe(240);
    expect(setup(900).rendered?.options.width).toBe(320);
  });
});
