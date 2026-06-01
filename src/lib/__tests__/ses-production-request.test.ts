import { buildSesProductionRequest, normalizeSesProductionRequestInput } from "../ses-production-request";

describe("SES production request helper", () => {
  it("normalizes blank optional fields into reviewer-friendly defaults", () => {
    const input = normalizeSesProductionRequestInput({
      sendingDomain: " Mail.Example.COM ",
      websiteUrl: "",
      region: " us-east-1 ",
      useCase: "",
      expectedVolume: "",
      optInSource: "",
      bounceHandling: "",
      complaintHandling: "",
    });

    expect(input.sendingDomain).toBe("mail.example.com");
    expect(input.websiteUrl).toBe("Not provided");
    expect(input.useCase).toBe("Transactional application email");
    expect(input.expectedVolume).toBe("Low initial production volume with gradual ramp-up");
  });

  it("builds a production-access request without asking for secrets", () => {
    const request = buildSesProductionRequest({
      sendingDomain: "example.com",
      websiteUrl: "https://example.com",
      region: "us-east-1",
      useCase: "Password resets and account notifications",
      expectedVolume: "2,000 messages per month",
      optInSource: "Only registered users who request account email",
      bounceHandling: "SNS webhook into FreeResend bounce handler",
      complaintHandling: "SNS complaint webhook with suppression",
    });

    expect(request.subject).toBe("Request production access for Amazon SES in us-east-1");
    expect(request.body).toContain("Sending domain: example.com");
    expect(request.body).toContain("Use case: Password resets and account notifications");
    expect(request.body).toContain("Bounce handling: SNS webhook into FreeResend bounce handler");
    expect(request.body).toContain("Complaint handling: SNS complaint webhook with suppression");
    expect(request.body).toContain("I am not including AWS access keys, SMTP passwords, or customer data in this request.");
    expect(request.body).not.toContain("SECRET_ACCESS_KEY");
  });
});
