import HermieGateway
import HermieStore

/// The keychain is where a gateway's secrets live on a device. `SecretStore` (HermieStore) and
/// `GatewaySecretStorage` (HermieGateway) declare the same three methods, and neither target may
/// import the other, so the conformance is declared here, where both are visible.
extension KeychainStore: GatewaySecretStorage {}

/// The in-memory store too, so a preview or a test can stand in for the keychain with either fake.
extension InMemorySecretStore: GatewaySecretStorage {}
