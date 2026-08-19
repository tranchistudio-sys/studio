export interface GisCredentialResponse {
  credential?: string;
  select_by?: string;
}

export interface GisIdentityConfiguration {
  client_id: string;
  callback: (response: GisCredentialResponse) => void;
  auto_select?: boolean;
  cancel_on_tap_outside?: boolean;
}

export interface GisButtonConfiguration {
  type?: "standard" | "icon";
  theme?: "outline" | "filled_blue" | "filled_black";
  size?: "large" | "medium" | "small";
  text?: "signin_with" | "signup_with" | "continue_with" | "signin";
  shape?: "rectangular" | "pill" | "circle" | "square";
  logo_alignment?: "left" | "center";
  width?: number;
  locale?: string;
}

export interface GoogleIdentityApi {
  initialize(config: GisIdentityConfiguration): void;
  renderButton(parent: HTMLElement, options: GisButtonConfiguration): void;
}

export function renderOfficialGoogleButton(input: {
  api: GoogleIdentityApi;
  host: HTMLElement;
  clientId: string;
  onCredential: (credential: string) => void;
  onError: (message: string) => void;
}): void {
  const { api, host, clientId, onCredential, onError } = input;
  api.initialize({
    client_id: clientId,
    auto_select: false,
    cancel_on_tap_outside: true,
    callback: response => {
      if (!response.credential) {
        onError("Google không trả về thông tin đăng nhập hợp lệ.");
        return;
      }
      onCredential(response.credential);
    },
  });

  host.replaceChildren();
  api.renderButton(host, {
    type: "standard",
    theme: "outline",
    size: "large",
    text: "signin_with",
    shape: "rectangular",
    logo_alignment: "left",
    locale: "vi",
    width: Math.max(240, Math.min(320, Math.floor(host.clientWidth || 320))),
  });
}
