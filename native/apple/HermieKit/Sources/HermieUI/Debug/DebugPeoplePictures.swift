#if DEBUG
  import HermieCore
  import HermieGateway
  import SwiftUI

  /// The people's pictures for the debug screens, with no gateway behind them: Robin (`telegram:42`)
  /// has a picture, everybody else is a 404 and stays an initial, so a screen shows both at once.
  enum DebugPeoplePictures {
    /// A 96-pixel picture of a head and shoulders on a warm gradient.
    static let robin =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAADzElEQVR42u3a11YbMRCAYT1dElJJJaGYEgyYkt577w+GwYBpBhJSSCG5yDskkkbKLjmWdm3vSCutzvmf4LvZ1cyQX+96f77lvZG97t2FXtH6dl+yftBeyJ6zvtOe9bOeir49kT2mDdC+PuI9lD0Y2IHul0T3Sl9od2V3aIOfabdlt1ifbspuDEEfr8uu8a4ObbOGt6/ILg9/gC7xLo7Q3tMuyGZYW7Rp2vmtKdHmpKzCIkFHo7NZGSVBR6OzMUGBgo5aJwYUdJrpbIwDUNBR6HCgoKPWYUBBR6OzMQZAQUeh02BAQUetA0BBR6nTKFOgoKPWaZTLJOhodBqjZRJ0NDocKOioddYjoKDTTGf9PAAFHYUOBwo6ah0BFHRUOusjZRJ0NDocKOioddYEkFWdP7939FnUWRseIxZ1Emn2MNnQiYAM67REE8+wztoQB3JFRxgZ1GFAbulAxnRiQO7oCCMjOquDAOSajjDC1+FAufxmpQTC1gEgJ3UgbJ3VEgfKw99g+0CYOqulceKujjDC1JFAyO8sZCBEnZUBCoT/CkUFQtWJAbmpI4zQdFb6AQhzgmEOCEGHAyHPdwwB4egwIOzplwkgNJ2VPgDCnA0aAMLTWWZAyJNTQ0A4OjEgzLmyuzrLvRPEwNQdFwhThwPh7ySQgRB1GJCZjY2jOsvnKJCRfRYWELJOPQLC3/a5qFM/C0BGdqEYQNg6HMjgptg5HQAyukd3S6feM0HMXxk4pFPvqRArNxiu6CxFQDYuVHL4zfpPZ+kMAFm938nD36BKhwO5fN2ErSOAgo5KZ+l0hQQdjU4MKOg001k8BUBBR6HDgYKOWicCCjpNdRZPThLrOon/QRZ1GJB5nQ7fYiZ1YkD4OpnPgwzoLJwAIGQd1KE9qg4HsvrOyowJR0cCIegYo4mXuc7CcQrki44wylSHAWWrY5FmD1NGOgvdDMg3HSgTnRoD8lEnMupMp9Y9RXzVEUad6dSOAZCnOlAnOhzIa53IqC0dBuS9jjBqS6d2FIB814Ha0JlnQA7+DbYP1KKOBCqAjjBqUWf+CAUqjA7Uko4Ayu0bHREonc784WlSKB1hlFqHA+Vp+mUOKJ3OXARUGB0opc7cIQCyN1e2B5RKhwMVT0cYpdARQCk3Nh4CJenMHZwmxvZZuQNKocOBCqkDJepUOVCqTbGfQEk61S4KlG6P7i2QVqfaNUNSXhn4CZSkUz3AgTK5wXAUSK/DgAqrA+l1YkDa6yb/gRQ6s/sBKOn2y3MgtQ4HSnEZ5zOQVucfUMLdoN9AGp3ZfTN/AUMsiolYExxgAAAAAElFTkSuQmCC"

    /// Robin has a picture; nobody else does.
    @MainActor static func make() -> PeoplePictures {
      PeoplePictures(gatewayID: "debug") { path in
        path == GatewayAddress.authPicturePath(id: "telegram:42") ? .ready(dataURI: robin) : .missing
      }
    }
  }
#endif
