import { useEffect } from 'react'
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import type { MapLinkLocation } from '../utils/mapLinks'

function MapViewport({ location }: { location: MapLinkLocation }): null {
  const map = useMap()
  useEffect(() => {
    const timer = window.setTimeout(() => {
      map.invalidateSize()
      if (location.coordinates) {
        map.setView(
          [location.coordinates.latitude, location.coordinates.longitude],
          location.zoom || 15,
          { animate: false }
        )
      }
    }, 40)
    return () => window.clearTimeout(timer)
  }, [location, map])
  return null
}

export default function MessageMapPreview({
  location
}: {
  location: MapLinkLocation
}): React.JSX.Element {
  if (location.provider === 'google' && location.embedUrl) {
    return (
      <iframe
        className="message-map-embed"
        src={location.embedUrl}
        title={`Interactive map for ${location.label}`}
        loading="lazy"
        referrerPolicy="no-referrer"
        allowFullScreen
      />
    )
  }

  if (location.coordinates) {
    const center: [number, number] = [location.coordinates.latitude, location.coordinates.longitude]
    return (
      <MapContainer
        className="message-map-leaflet"
        center={center}
        zoom={location.zoom || 15}
        scrollWheelZoom={false}
        zoomControl
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <CircleMarker
          center={center}
          radius={8}
          pathOptions={{ color: '#ffffff', fillColor: '#6e72ff', fillOpacity: 1, weight: 3 }}
        >
          <Popup>{location.label}</Popup>
        </CircleMarker>
        <MapViewport location={location} />
      </MapContainer>
    )
  }

  return (
    <div className="message-map-unavailable">
      <strong>Preview unavailable</strong>
      <span>This link does not expose a searchable place or coordinates.</span>
    </div>
  )
}
